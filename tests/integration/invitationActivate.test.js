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

const PREFIX = 'activate-invite-';
const address = () => `${PREFIX}${crypto.randomUUID()}@example.com`;

async function sessionFor(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Akt', 'Iv', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [address(), groupKey]
  );
  return { id: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

async function invite(port, cookie, email) {
  const res = await fetch(`http://localhost:${port}/members/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ email, firstName: 'Neu', lastName: 'Mitglied', sendEmail: false }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

const activate = (port, cookie, id) => fetch(`http://localhost:${port}/members/invitations/${id}/activate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
});

test('an admin turns an open invitation into an active member without a password', async () => {
  await withTestServer(async (port) => {
    const admin = await sessionFor('admin');
    const email = address();
    const invitationId = await invite(port, admin.cookie, email);

    const res = await activate(port, admin.cookie, invitationId);
    assert.equal(res.status, 200);
    const { id, link } = await res.json();
    assert.match(link, /\/reset-password\.html\?token=[0-9a-f]{64}$/);

    const { rows: [user] } = await query('SELECT email, first_name, password_hash, is_guest, email_verified, access_token FROM users WHERE id = $1', [id]);
    assert.equal(user.email, email);
    assert.equal(user.first_name, 'Neu');
    assert.equal(user.password_hash, null);
    assert.equal(user.is_guest, false);
    assert.equal(user.email_verified, true);
    assert.ok(link.endsWith(user.access_token));

    const members = await (await fetch(`http://localhost:${port}/members`, { headers: { Cookie: admin.cookie } })).json();
    assert.equal(members.find((m) => m.id === invitationId), undefined, 'no longer listed as invited');
    assert.equal(members.find((m) => m.id === id)?.status, 'active');

    // The access link sets the first password.
    const token = link.split('token=')[1];
    const confirm = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: 'ein sicheres passwort' }),
    });
    assert.equal(confirm.status, 200);

    assert.equal((await activate(port, admin.cookie, invitationId)).status, 409, 'cannot activate twice');
  });
});

test('only admins may activate, and an address already in use is refused', async () => {
  await withTestServer(async (port) => {
    const admin = await sessionFor('admin');
    const moderator = await sessionFor('moderator');
    const email = address();
    const invitationId = await invite(port, admin.cookie, email);
    assert.equal((await activate(port, moderator.cookie, invitationId)).status, 403);

    await query("INSERT INTO users (email, first_name, last_name, group_id) VALUES ($1, 'Schon', 'Da', (SELECT id FROM groups WHERE key = 'mitglied'))", [email]);
    assert.equal((await activate(port, admin.cookie, invitationId)).status, 409);
    assert.equal((await query('SELECT redeemed_at FROM invitations WHERE id = $1', [invitationId])).rows[0].redeemed_at, null, 'rolled back');
  });
});

test.after(async () => {
  await query('DELETE FROM invitations WHERE email LIKE $1', [`${PREFIX}%`]);
  await query('DELETE FROM audit_log WHERE subject_user_id IN (SELECT id FROM users WHERE email LIKE $1) OR actor_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${PREFIX}%`]);
  await query('DELETE FROM users WHERE email LIKE $1', [`${PREFIX}%`]);
  await closePool();
});
