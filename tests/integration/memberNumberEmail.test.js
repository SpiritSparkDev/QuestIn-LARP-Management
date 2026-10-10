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

const PREFIX = 'member-nr-';
const address = () => `${PREFIX}${crypto.randomUUID()}@example.com`;

async function makeUser(groupKey = 'mitglied', email = address()) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Num', 'Mer', (SELECT id FROM groups WHERE key = $2), true) RETURNING id, member_number",
    [email, groupKey]
  );
  return { id: rows[0].id, number: rows[0].member_number, email, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

test('every account gets a unique member number in order of creation', async () => {
  const first = await makeUser();
  const second = await makeUser();
  assert.ok(Number.isInteger(first.number));
  assert.ok(second.number > first.number);
  const { rows } = await query('SELECT count(*)::int AS n, count(DISTINCT member_number)::int AS d, count(member_number)::int AS c FROM users');
  assert.equal(rows[0].n, rows[0].d);
  assert.equal(rows[0].n, rows[0].c);
});

test('the member list and detail carry the member number', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const member = await makeUser();
    const list = await (await fetch(`http://localhost:${port}/members`, { headers: { Cookie: admin.cookie } })).json();
    assert.equal(list.find((m) => m.id === member.id).memberNumber, member.number);
    const detail = await (await fetch(`http://localhost:${port}/members/${member.id}`, { headers: { Cookie: admin.cookie } })).json();
    assert.equal(detail.memberNumber, member.number);
  });
});

test("an admin changes a member's e-mail address; old links stop working, taken addresses are refused", async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const moderator = await makeUser('moderator');
    const member = await makeUser();
    const other = await makeUser();
    const put = (who, id, email) => fetch(`http://localhost:${port}/members/${id}/email`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: who.cookie }, body: JSON.stringify({ email }),
    });
    const tokenBefore = (await query('SELECT access_token FROM users WHERE id = $1', [member.id])).rows[0].access_token;

    assert.equal((await put(moderator, member.id, address())).status, 403);
    assert.equal((await put(admin, member.id, 'kaputt')).status, 400);
    assert.equal((await put(admin, member.id, other.email.toUpperCase())).status, 409);

    const fresh = address();
    const res = await put(admin, member.id, ` ${fresh.toUpperCase()} `);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: fresh, changed: true });
    const { rows: [after] } = await query('SELECT email, access_token FROM users WHERE id = $1', [member.id]);
    assert.equal(after.email, fresh);
    assert.notEqual(after.access_token, tokenBefore);
  });
});

test('a member without an e-mail address gets one added', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const { rows: [noMail] } = await query("INSERT INTO users (first_name, last_name, group_id) VALUES ('Ohne', 'Mail', (SELECT id FROM groups WHERE key = 'mitglied')) RETURNING id");
    const fresh = address();
    const res = await fetch(`http://localhost:${port}/members/${noMail.id}/email`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: JSON.stringify({ email: fresh }),
    });
    assert.equal(res.status, 200);
    assert.equal((await query('SELECT email FROM users WHERE id = $1', [noMail.id])).rows[0].email, fresh);
  });
});

test.after(async () => {
  await query('DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${PREFIX}%`]);
  await query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${PREFIX}%`]);
  await query('DELETE FROM users WHERE email LIKE $1', [`${PREFIX}%`]);
  await closePool();
});
