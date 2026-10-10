import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { sendVerificationEmail, deliver } = await import('../../backend/auth/mailer.js');
const { purgeOldEmailLog } = await import('../../backend/emailLog/repository.js');
const { flushMailOutbox } = await import('../../backend/emailLog/outbox.js');
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');

test.beforeEach(resetRateLimits);

const PREFIX = 'email-log-test-';
const address = () => `${PREFIX}${crypto.randomUUID()}@example.com`;
const logFor = async (to) => (await query('SELECT * FROM email_log WHERE to_address = $1 ORDER BY created_at', [to])).rows;

async function makeUser(groupKey = 'mitglied', { isGuest = false, email = address() } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, email_verified, is_guest)
     VALUES ($1, 'Log', 'Test', (SELECT id FROM groups WHERE key = $2), true, $3) RETURNING id`,
    [email, groupKey, isGuest]
  );
  return { id: rows[0].id, email };
}

async function adminCookie() {
  const { id } = await makeUser('admin');
  return `session=${(await createSession(id)).token}`;
}

const resetRequest = (port, email) => fetch(`http://localhost:${port}/auth/password-reset/request`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
});

test('without an SMTP host a mail is logged as not_configured, with slot and user', async () => {
  const user = await makeUser();
  await sendVerificationEmail(user.email, 'tok', { userId: user.id });
  const [entry] = await logFor(user.email);
  assert.equal(entry.status, 'not_configured');
  assert.equal(entry.slot, 'verification');
  assert.equal(entry.user_id, user.id);
});

test('a transporter error is logged as failed and rethrown; test persons are skipped', async () => {
  const to = address();
  const broken = { sendMail: async () => { throw new Error('550 sender rejected'); } };
  await assert.rejects(deliver(broken, 'x@example.com', to, { subject: 'S', body: 'B', slot: 'waitlisted' }), /550/);
  const [failed] = await logFor(to);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '550 sender rejected');

  const testPerson = `${PREFIX}${crypto.randomUUID()}@test.invalid`;
  await deliver(broken, 'x@example.com', testPerson, { subject: 'S', body: 'B', slot: 'waitlisted' });
  assert.equal((await logFor(testPerson))[0].status, 'skipped');
});

test('"Passwort vergessen" for an open (even expired) invitation renews it and sends the invitation', async () => {
  await withTestServer(async (port) => {
    const email = address();
    const inviter = await makeUser('admin');
    const { rows: [inv] } = await query(
      `INSERT INTO invitations (token, email, first_name, last_name, group_id, invited_by, expires_at)
       VALUES ($1, $2, 'Ein', 'Geladen', (SELECT id FROM groups WHERE key = 'mitglied'), $3, now() - interval '1 day') RETURNING id, token`,
      [crypto.randomBytes(16).toString('hex'), email, inviter.id]
    );
    assert.equal((await resetRequest(port, email.toUpperCase())).status, 200);

    const { rows: [after] } = await query('SELECT token, expires_at FROM invitations WHERE id = $1', [inv.id]);
    assert.notEqual(after.token, inv.token);
    assert.ok(new Date(after.expires_at) > new Date(Date.now() + 13 * 24 * 3600 * 1000), 'renewed for the configured 14 days');
    const [entry] = await logFor(email);
    assert.equal(entry.slot, 'invitation');
  });
});

test('"Passwort vergessen" for a Direktanmeldung (guest) sends the ticket mail instead of nothing', async () => {
  await withTestServer(async (port) => {
    const guest = await makeUser('mitglied', { isGuest: true });
    assert.equal((await resetRequest(port, ` ${guest.email} `)).status, 200);
    const [entry] = await logFor(guest.email);
    assert.equal(entry.slot, 'guest_access');
    assert.equal(entry.user_id, guest.id);
  });
});

test('"Passwort vergessen" sends nothing for unknown or deactivated addresses', async () => {
  await withTestServer(async (port) => {
    const unknown = address();
    await resetRequest(port, unknown);
    assert.equal((await logFor(unknown)).length, 0);

    const gone = await makeUser();
    await query('UPDATE users SET deactivated_at = now() WHERE id = $1', [gone.id]);
    await resetRequest(port, gone.email);
    assert.equal((await logFor(gone.email)).length, 0);
  });
});

test('GET /admin/email-log is admin-only, filters by status and per member; health names the missing SMTP server', async () => {
  await withTestServer(async (port) => {
    const member = await makeUser();
    const memberCookie = `session=${(await createSession(member.id)).token}`;
    assert.equal((await fetch(`http://localhost:${port}/admin/email-log`, { headers: { Cookie: memberCookie } })).status, 403);

    await sendVerificationEmail(member.email, 'tok', { userId: member.id });
    const headers = { Cookie: await adminCookie() };
    const list = await (await fetch(`http://localhost:${port}/admin/email-log?search=${encodeURIComponent(member.email)}&status=not_configured`, { headers })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].to, member.email);
    assert.equal((await fetch(`http://localhost:${port}/admin/email-log?status=bogus`, { headers })).status, 400);

    const forMember = await (await fetch(`http://localhost:${port}/admin/email-log/members/${member.id}`, { headers })).json();
    assert.equal(forMember[0].slot, 'verification');

    const health = await (await fetch(`http://localhost:${port}/admin/email-log/health`, { headers })).json();
    assert.ok(health.problems.some((p) => p.level === 'error' && p.text.includes('SMTP')));
    assert.ok(health.problems.some((p) => p.text.includes('localhost')));
  });
});

test('entries older than 90 days are purged', async () => {
  const to = address();
  await query("INSERT INTO email_log (to_address, status, created_at) VALUES ($1, 'sent', now() - interval '91 days'), ($1, 'sent', now() - interval '89 days')", [to]);
  await purgeOldEmailLog();
  assert.equal((await logFor(to)).length, 1);
});

test('offline outbox mails stay queued while no SMTP server is configured', async () => {
  const user = await makeUser();
  const { rows: [mail] } = await query(
    `INSERT INTO mail_outbox (to_address, subject, body, slot, user_id) VALUES ($1, 'S', 'B', 'payment_received', $2) RETURNING id`,
    [`offline-${user.id}@offline.invalid`, user.id]
  );
  const result = await flushMailOutbox();
  assert.ok(result.notConfigured >= 1);
  assert.equal((await query('SELECT sent_at FROM mail_outbox WHERE id = $1', [mail.id])).rows[0].sent_at, null);
  await query('DELETE FROM mail_outbox WHERE id = $1', [mail.id]);
});

test.after(async () => {
  await query('DELETE FROM email_log WHERE to_address LIKE $1', [`${PREFIX}%`]);
  await query('DELETE FROM invitations WHERE email LIKE $1', [`${PREFIX}%`]);
  await query('DELETE FROM users WHERE email LIKE $1', [`${PREFIX}%`]);
  await closePool();
});
