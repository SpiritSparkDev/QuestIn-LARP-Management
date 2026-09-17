import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { migrateRegistrationDataBlob } = await import('../../db/migrateRegistrationDataBlob.js');
await migrateRegistrationDataBlob();

const { query, closePool } = await import('../../backend/db.js');

async function makeUser() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id) VALUES ($1, 'Reg', 'Test', (SELECT id FROM groups WHERE key = 'mitglied')) RETURNING id",
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

async function makeCharacter(userId) {
  const { rows } = await query(
    "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Test Char', '{}') RETURNING id",
    [userId]
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
  const characterId = await makeCharacter(userId);
  await query('INSERT INTO registrations (user_id, event_id, character_id) VALUES ($1, $2, $3)', [userId, eventId, characterId]);
  await assert.rejects(
    query('INSERT INTO registrations (user_id, event_id, character_id) VALUES ($1, $2, $3)', [userId, eventId, characterId]),
    /duplicate key value violates/
  );
});

test('status must be one of the allowed values', async () => {
  const userId = await makeUser();
  const eventId = await makeEvent();
  const characterId = await makeCharacter(userId);
  await assert.rejects(
    query(
      "INSERT INTO registrations (user_id, event_id, status, character_id) VALUES ($1, $2, 'not-a-real-status', $3)",
      [userId, eventId, characterId]
    ),
    /violates check constraint/
  );
});

test('registrations_character_con_role_check rejects an sc registration with no character_id', async () => {
  const { query } = await import('../../backend/db.js');
  const { rows: userRows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'C', 'T', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`schema-reg-${crypto.randomUUID()}@example.com`]
  );
  const { rows: eventRows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Schema Con', '2027-01-01') RETURNING id"
  );
  await assert.rejects(
    query(
      "INSERT INTO registrations (user_id, event_id, con_role) VALUES ($1, $2, 'sc')",
      [userRows[0].id, eventRows[0].id]
    ),
    /registrations_character_con_role_check/
  );
});

test('registrations.con_tage_enc column no longer exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'registrations' AND column_name = 'con_tage_enc'`
  );
  assert.equal(rows.length, 0);
});

test('registrations.registration_data_enc column exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'registrations' AND column_name = 'registration_data_enc'`
  );
  assert.equal(rows.length, 1);
});

test.after(async () => {
  await closePool();
});
