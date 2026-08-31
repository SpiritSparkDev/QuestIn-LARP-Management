import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession, getSession, destroySession } = await import('../../backend/auth/sessions.js');

async function makeUser() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id) VALUES ($1, 'Test', '', (SELECT id FROM groups WHERE key = 'sc')) RETURNING id",
    [`session-test-${Date.now()}-${Math.random()}@example.com`]
  );
  return rows[0].id;
}

test('creates a session and retrieves it by token', async () => {
  const userId = await makeUser();
  const session = await createSession(userId);
  assert.ok(session.token);
  assert.ok(session.expiresAt instanceof Date);

  const found = await getSession(session.token);
  assert.equal(found.userId, userId);
});

test('an unknown token returns null', async () => {
  assert.equal(await getSession('does-not-exist'), null);
});

test('an expired session returns null and is deleted', async () => {
  const userId = await makeUser();
  const token = 'expired-token-test';
  await query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() - interval '1 hour')",
    [token, userId]
  );

  assert.equal(await getSession(token), null);

  const { rows } = await query('SELECT token FROM sessions WHERE token = $1', [token]);
  assert.equal(rows.length, 0);
});

test('destroySession removes the session', async () => {
  const userId = await makeUser();
  const session = await createSession(userId);
  await destroySession(session.token);
  assert.equal(await getSession(session.token), null);
});

test.after(async () => {
  await closePool();
});
