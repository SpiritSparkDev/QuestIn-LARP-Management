import { test, after } from 'node:test';
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
const { getScCharacterSchema } = await import('../../backend/scSchema/repository.js');

const originalSchema = await getScCharacterSchema();
after(async () => {
  await query('UPDATE sc_character_schema SET schema = $1', [JSON.stringify(originalSchema)]);
  await closePool();
});

async function makeSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Confirm', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`checkin-confirm-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

test('flagged character fields are asked again, corrected, and unflagged ones are ignored', async () => {
  await query('UPDATE sc_character_schema SET schema = $1', [JSON.stringify([
    { key: 'allergy', label: 'Allergie', type: 'text', required: false, checkinConfirm: true },
    { key: 'story', label: 'Story', type: 'text', required: false },
  ])]);
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const staff = await makeSession('moderator');
    const player = await makeSession('mitglied');
    const { rows: [event] } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Confirm Con', '2027-09-01', true) RETURNING id");
    const { rows: [character] } = await query(
      "INSERT INTO characters (user_id, name, data) VALUES ($1, 'Conny', $2) RETURNING id",
      [player.userId, JSON.stringify({ allergy: 'Nüsse', story: 'alt' })]
    );
    await query("INSERT INTO registrations (user_id, event_id, status, character_id) VALUES ($1, $2, 'confirmed', $3)", [player.userId, event.id, character.id]);
    const url = `${base}/events/${event.id}/checkin-confirm/${player.userId}`;
    const call = (cookie, method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });

    assert.equal((await call(player.cookie, 'GET')).status, 403);

    const got = await (await call(staff.cookie, 'GET')).json();
    assert.deepEqual(got.character.fields.map((f) => f.key), ['allergy']);
    assert.equal(got.character.values.allergy, 'Nüsse');

    assert.equal((await call(staff.cookie, 'PUT', { character: { allergy: 'keine', story: 'hacked' } })).status, 200);
    const { rows: [saved] } = await query('SELECT data FROM characters WHERE id = $1', [character.id]);
    assert.deepEqual(saved.data, { allergy: 'keine', story: 'alt' });
  });
});
