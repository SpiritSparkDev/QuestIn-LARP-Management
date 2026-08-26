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

async function makeUser() {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id) VALUES ($1, 'Reg Test', (SELECT id FROM groups WHERE key = 'sc')) RETURNING id",
    [`reg-schema-${crypto.randomUUID()}@example.com`]
  );
  return rows[0].id;
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Reg Schema Con', '2027-06-01') RETURNING id"
  );
  return rows[0].id;
}

test('registrations table exists after migration', async () => {
  const { rows } = await query("SELECT to_regclass('registrations') AS exists");
  assert.ok(rows[0].exists);
});

test('a user can register for an event at most once (primary key enforced)', async () => {
  const userId = await makeUser();
  const eventId = await makeEvent();
  await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [userId, eventId]);
  await assert.rejects(
    query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [userId, eventId]),
    /duplicate key value violates/
  );
});

test('status must be one of the allowed values', async () => {
  const userId = await makeUser();
  const eventId = await makeEvent();
  await assert.rejects(
    query(
      "INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'not-a-real-status')",
      [userId, eventId]
    ),
    /violates check constraint/
  );
});

test.after(async () => {
  await closePool();
});
