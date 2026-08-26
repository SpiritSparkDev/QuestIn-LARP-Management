import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');

test('events and characters tables exist after migration', async () => {
  for (const table of ['events', 'characters']) {
    const { rows } = await query('SELECT to_regclass($1) AS exists', [table]);
    assert.ok(rows[0].exists, `expected table "${table}" to exist`);
  }
});

test('characters.user_id foreign key is enforced', async () => {
  const { rows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('FK Test', '2027-01-01') RETURNING id"
  );
  await assert.rejects(
    query(
      'INSERT INTO characters (user_id, event_id, name) VALUES ($1, $2, $3)',
      [crypto.randomUUID(), rows[0].id, 'Ghost']
    ),
    /violates foreign key constraint/
  );
  await query('DELETE FROM events WHERE id = $1', [rows[0].id]);
});

test('characters.event_id foreign key is enforced', async () => {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id) VALUES ($1, 'FK Test', (SELECT id FROM groups WHERE key = 'sc')) RETURNING id",
    [`fk-test-${Date.now()}@example.com`]
  );
  await assert.rejects(
    query(
      'INSERT INTO characters (user_id, event_id, name) VALUES ($1, $2, $3)',
      [rows[0].id, crypto.randomUUID(), 'Ghost']
    ),
    /violates foreign key constraint/
  );
  await query('DELETE FROM users WHERE id = $1', [rows[0].id]);
});

test.after(async () => {
  await closePool();
});
