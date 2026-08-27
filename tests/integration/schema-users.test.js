import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');

test('users/sessions/tokens tables exist after migration', async () => {
  for (const table of ['users', 'sessions', 'email_verification_tokens', 'password_reset_tokens', 'groups', 'nsc_profile_schema']) {
    const { rows } = await query('SELECT to_regclass($1) AS exists', [table]);
    assert.ok(rows[0].exists, `expected table "${table}" to exist`);
  }
});

test('users.email is unique', async () => {
  const email = `unique-${Date.now()}@example.com`;
  await query(
    "INSERT INTO users (email, name, group_id) VALUES ($1, 'A', (SELECT id FROM groups WHERE key = 'sc'))",
    [email]
  );
  await assert.rejects(
    query("INSERT INTO users (email, name, group_id) VALUES ($1, 'B', (SELECT id FROM groups WHERE key = 'sc'))", [email]),
    /duplicate key value violates unique constraint/
  );
  await query('DELETE FROM users WHERE email = $1', [email]);
});

test.after(async () => {
  await closePool();
});
