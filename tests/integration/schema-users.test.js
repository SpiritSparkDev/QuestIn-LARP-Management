import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { GROUP_DEFAULTS } = await import('../../db/groupDefaults.js');
const SEEDED_GROUP_KEYS = GROUP_DEFAULTS.map((g) => g.key);

test('users/sessions/tokens tables exist after migration', async () => {
  for (const table of ['users', 'sessions', 'email_verification_tokens', 'password_reset_tokens', 'groups', 'nsc_profile_schema']) {
    const { rows } = await query('SELECT to_regclass($1) AS exists', [table]);
    assert.ok(rows[0].exists, `expected table "${table}" to exist`);
  }
});

test('users.email is unique', async () => {
  const email = `unique-${Date.now()}@example.com`;
  await query(
    "INSERT INTO users (email, first_name, last_name, group_id) VALUES ($1, 'A', '', (SELECT id FROM groups WHERE key = 'mitglied'))",
    [email]
  );
  await assert.rejects(
    query("INSERT INTO users (email, first_name, last_name, group_id) VALUES ($1, 'B', '', (SELECT id FROM groups WHERE key = 'mitglied'))", [email]),
    /duplicate key value violates unique constraint/
  );
  await query('DELETE FROM users WHERE email = $1', [email]);
});

test('users.pronomen_enc column no longer exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pronomen_enc'`
  );
  assert.equal(rows.length, 0);
});

test('exactly 3 groups exist after migration: admin, moderator, mitglied', async () => {
  const { rows } = await query('SELECT key FROM groups ORDER BY key');
  assert.deepEqual(rows.map((r) => r.key), ['admin', 'mitglied', 'moderator']);
});

test('registrations.con_role is backfilled and NOT NULL after migration', async () => {
  const { rows } = await query(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'registrations' AND column_name = 'con_role'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_nullable, 'NO');
});

test('users.nsc_data column no longer exists after migration', async () => {
  const { rows } = await query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'nsc_data'"
  );
  assert.equal(rows.length, 0);
});

test('admin and moderator have can_override_checkin_status=true after migration; mitglied false', async () => {
  const { rows } = await query('SELECT key, can_override_checkin_status FROM groups WHERE key = ANY($1)', [SEEDED_GROUP_KEYS]);
  for (const row of rows) {
    const expected = ['admin', 'moderator'].includes(row.key);
    assert.equal(row.can_override_checkin_status, expected, `${row.key} should have can_override_checkin_status=${expected}`);
  }
});

test('users.name column no longer exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'name'`
  );
  assert.equal(rows.length, 0);
});

test('users.first_name and users.last_name columns exist and are NOT NULL', async () => {
  const { rows } = await query(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'users' AND column_name IN ('first_name', 'last_name')`
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.is_nullable, 'NO', `${row.column_name} should be NOT NULL`);
  }
});

test.after(async () => {
  await closePool();
});
