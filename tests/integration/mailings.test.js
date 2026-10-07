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
const { cleanMailHtml, parseManualEmails } = await import('../../backend/mailings/repository.js');

const tag = crypto.randomUUID().slice(0, 8);

async function makeUser(groupKey, label, { isGuest = false } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, email_verified, is_guest)
     VALUES ($1, 'Mail', $2, (SELECT id FROM groups WHERE key = $3), true, $4) RETURNING id, email`,
    [`mailing-${tag}-${label}@example.com`, label, groupKey, isGuest]
  );
  return rows[0];
}

test('cleanMailHtml drops active content but keeps layout; parseManualEmails splits and validates', () => {
  const html = cleanMailHtml('<p style="color:red" onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:evil()">l</a><img src="https://x/y.png">');
  assert.equal(html.includes('script'), false);
  assert.equal(html.includes('onclick'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.ok(html.includes('style="color:red"') && html.includes('<img'));

  const { valid, invalid } = parseManualEmails('a@x.de, B@X.de;  kaputt\nc@y.de');
  assert.deepEqual(valid, ['a@x.de', 'b@x.de', 'c@y.de']);
  assert.deepEqual(invalid, ['kaputt']);
});

test('recipients: filters, manual addresses, de-duplication, sending and permissions', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUser('admin', 'admin');
    const member = await makeUser('mitglied', 'member');
    const cookie = `session=${(await createSession(admin.id)).token}`;
    const memberCookie = `session=${(await createSession(member.id)).token}`;
    const headers = (c) => ({ 'Content-Type': 'application/json', Cookie: c });

    const { rows: ev } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Mailing Test Con', '2027-09-01', true) RETURNING id");
    const eventId = ev[0].id;

    const paidSc = await makeUser('mitglied', 'paidsc');
    const openNsc = await makeUser('mitglied', 'opennsc');
    const guest = await makeUser('mitglied', 'guest', { isGuest: true });
    const cancelled = await makeUser('mitglied', 'cancelled');
    const reg = (u, role, status, paid) => query(
      'INSERT INTO registrations (user_id, event_id, con_role, status, paid_at) VALUES ($1, $2, $3, $4, $5)',
      [u.id, eventId, role, status, paid ? new Date() : null]);
    await reg(paidSc, 'sc', 'confirmed', true);
    await reg(openNsc, 'nsc', 'pending', false);
    await reg(guest, 'sc', 'pending', false);
    await reg(cancelled, 'sc', 'cancelled', false);

    const preview = async (body) => (await (await fetch(`${base}/events/${eventId}/mailing/preview`, { method: 'POST', headers: headers(cookie), body: JSON.stringify(body) })).json());

    assert.equal((await preview({ includeRegistered: true })).registered, 3, 'cancelled is left out by default');
    assert.equal((await preview({ includeRegistered: false, manualEmails: '' })).total, 0);
    assert.equal((await preview({ includeRegistered: true, filter: { payment: 'paid' } })).registered, 1);
    assert.equal((await preview({ includeRegistered: true, filter: { payment: 'unpaid' } })).registered, 2);
    assert.equal((await preview({ includeRegistered: true, filter: { conRoles: ['nsc'] } })).registered, 1);
    assert.equal((await preview({ includeRegistered: true, filter: { guestsOnly: true } })).registered, 1);
    assert.equal((await preview({ includeRegistered: true, filter: { statuses: ['cancelled'] } })).registered, 1);

    // Manual addresses are added; one already in the database counts only once.
    const manual = `extra-${tag}@example.com, ${paidSc.email}, kaputt`;
    const both = await preview({ includeRegistered: true, manualEmails: manual });
    assert.deepEqual([both.registered, both.manual, both.invalid, both.total], [3, 1, ['kaputt'], 4]);

    const send = (body, c = cookie) => fetch(`${base}/events/${eventId}/mailing`, { method: 'POST', headers: headers(c), body: JSON.stringify(body) });
    assert.equal((await send({ subject: '', bodyHtml: '<p>x</p>', includeRegistered: true })).status, 400);
    assert.equal((await send({ subject: 'Hi', bodyHtml: '<p> </p>', includeRegistered: true })).status, 400);
    assert.equal((await send({ subject: 'Hi', bodyHtml: '<p>x</p>', manualEmails: 'kaputt' })).status, 400, 'invalid address blocks sending');
    assert.equal((await send({ subject: 'Hi', bodyHtml: '<p>x</p>' })).status, 400, 'no recipients');
    assert.equal((await send({ subject: 'Hi', bodyHtml: '<p>x</p>', includeRegistered: true }, memberCookie)).status, 403);

    const res = await send({ subject: 'Rundmail', bodyHtml: '<p><b>Hallo</b></p><script>x()</script>', includeRegistered: true, filter: { payment: 'unpaid' }, manualEmails: `extra-${tag}@example.com` });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).total, 3);

    let list;
    for (let i = 0; i < 50; i += 1) {
      list = await (await fetch(`${base}/events/${eventId}/mailings`, { headers: headers(cookie) })).json();
      if (list[0]?.status === 'done') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(list[0].status, 'done');
    assert.deepEqual([list[0].recipientCount, list[0].sentCount, list[0].failedCount], [3, 3, 0]);
    const { rows } = await query('SELECT body_html FROM event_mailings WHERE id = $1', [list[0].id]);
    assert.equal(rows[0].body_html.includes('script'), false);

    // Test mail goes to the sender only.
    const testRes = await send({ subject: 'Test', bodyHtml: '<p>x</p>', testOnly: true });
    assert.equal((await testRes.json()).total, 1);
  });
});

test.after(async () => {
  await query("DELETE FROM events WHERE name = 'Mailing Test Con'");
  await query("DELETE FROM users WHERE email LIKE 'mailing-%'");
  await closePool();
});
