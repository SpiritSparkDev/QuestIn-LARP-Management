import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { hashPassword } = await import('../../backend/crypto/password.js');
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');

async function makeUser(password) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified, password_hash) VALUES ($1, 'Pw', 'Test', (SELECT id FROM groups WHERE key = 'mitglied'), true, $2) RETURNING id, email",
    [`pwchange-${crypto.randomUUID()}@example.com`, password ? await hashPassword(password) : null]
  );
  const here = await createSession(rows[0].id);
  const other = await createSession(rows[0].id);
  return { id: rows[0].id, email: rows[0].email, cookie: `session=${here.token}`, otherToken: other.token };
}

const put = (port, cookie, body) => fetch(`http://localhost:${port}/account/password`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
});

test('changing the password needs the current one; other sessions end, this one stays; the new password logs in', async () => {
  resetRateLimits();
  await withTestServer(async (port) => {
    const user = await makeUser('altes-passwort-1');
    assert.equal((await put(port, user.cookie, { currentPassword: 'falsch', newPassword: 'neues-passwort-2' })).status, 400);
    assert.equal((await put(port, user.cookie, { currentPassword: 'altes-passwort-1', newPassword: 'kurz' })).status, 400);
    assert.equal((await put(port, user.cookie, { currentPassword: 'altes-passwort-1', newPassword: 'altes-passwort-1' })).status, 400);

    assert.equal((await put(port, user.cookie, { currentPassword: 'altes-passwort-1', newPassword: 'neues-passwort-2' })).status, 200);
    // this session still works, the other one is gone
    assert.equal((await fetch(`http://localhost:${port}/account`, { headers: { Cookie: user.cookie } })).status, 200);
    assert.equal((await fetch(`http://localhost:${port}/account`, { headers: { Cookie: `session=${user.otherToken}` } })).status, 401);

    const login = (password) => fetch(`http://localhost:${port}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
    assert.equal((await login('altes-passwort-1')).status, 401);
    assert.equal((await login('neues-passwort-2')).status, 200);
  });
});

test('an account without a password may set its first one; guessing the current password is limited per account', async () => {
  resetRateLimits();
  await withTestServer(async (port) => {
    const fresh = await makeUser(null);
    assert.equal((await put(port, fresh.cookie, { newPassword: 'erstes-passwort-3' })).status, 200);

    const guessed = await makeUser('richtiges-passwort-4');
    for (let i = 0; i < 5; i += 1) assert.equal((await put(port, guessed.cookie, { currentPassword: `falsch-${i}`, newPassword: 'neues-passwort-5' })).status, 400);
    assert.equal((await put(port, guessed.cookie, { currentPassword: 'richtiges-passwort-4', newPassword: 'neues-passwort-5' })).status, 429);
  });
});

test('without a login there is no access', async () => {
  await withTestServer(async (port) => {
    assert.equal((await fetch(`http://localhost:${port}/account/password`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'pwchange-%'");
  await closePool();
});
