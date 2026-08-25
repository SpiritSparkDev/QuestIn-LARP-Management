import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { query, closePool } = await import('../../backend/db.js');

test('events and characters tables exist after migration', async () => {
  for (const table of ['events', 'characters']) {
    const { rows } = await query('SELECT to_regclass($1) AS exists', [table]);
    assert.ok(rows[0].exists, `expected table "${table}" to exist`);
  }
});

test('a character requires a valid event_id and user_id (foreign keys enforced)', async () => {
  await assert.rejects(
    query(
      "INSERT INTO characters (user_id, event_id, name) VALUES (gen_random_uuid(), gen_random_uuid(), 'Ghost')"
    ),
    /violates foreign key constraint/
  );
});

test.after(async () => {
  await closePool();
});
