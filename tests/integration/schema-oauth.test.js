import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { query, closePool } = await import('../../backend/db.js');

test('oauth_accounts table exists after migration', async () => {
  const { rows } = await query("SELECT to_regclass('oauth_accounts') AS exists");
  assert.ok(rows[0].exists);
});

test('(provider, provider_user_id) is unique', async () => {
  const { rows: userRows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'OAuth Uniq', 'participant', true) RETURNING id",
    [`oauth-uniq-${Date.now()}@example.com`]
  );
  const userId = userRows[0].id;

  await query(
    "INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'google', 'dup-provider-id')",
    [userId]
  );
  await assert.rejects(
    query(
      "INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'google', 'dup-provider-id')",
      [userId]
    ),
    /duplicate key value violates unique constraint/
  );

  await query('DELETE FROM users WHERE id = $1', [userId]);
});

test.after(async () => {
  await closePool();
});
