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

async function makeUser(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Scan', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`scan-lookup-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return rows[0].id;
}

async function makeEvent(code) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, code) VALUES ('Scan Test Event', '2027-01-01', $1) RETURNING id",
    [code]
  );
  return rows[0].id;
}

test('GET .../scan-lookup resolves a valid, well-formed code to name/group/status/characters', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const scUserId = await makeUser('sc');
    const staffUserId = await makeUser('admin');
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [scUserId, eventId]);
    await query(
      "INSERT INTO characters (user_id, event_id, class, name, data) VALUES ($1, $2, 'sc', 'Aldric', '{}')",
      [scUserId, eventId]
    );
    const session = await createSession(staffUserId);
    const cookie = `session=${session.token}`;

    const code = `P17/2027-sc-${scUserId}`;
    const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, scUserId);
    assert.equal(body.group, 'sc');
    assert.equal(body.status, 'pending');
    assert.deepEqual(body.characters.map((c) => c.name), ['Aldric']);
  });
});

test('GET .../scan-lookup rejects a malformed code with 400, without ever querying the DB for it', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const staffUserId = await makeUser('admin');
    const cookie = `session=${(await createSession(staffUserId)).token}`;

    for (const badCode of ['not-a-real-code', 'P17/2027-sc-not-a-uuid', '']) {
      const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=${encodeURIComponent(badCode)}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(res.status, 400, `expected 400 for code: ${JSON.stringify(badCode)}`);
    }
  });
});

test('GET .../scan-lookup rejects a code whose eventCode belongs to a different event', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const otherEventId = await makeEvent('OTHER/2027');
    const scUserId = await makeUser('sc');
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [scUserId, otherEventId]);
    const staffUserId = await makeUser('admin');
    const cookie = `session=${(await createSession(staffUserId)).token}`;

    // A code minted for otherEventId, scanned against eventId's URL.
    const code = `OTHER/2027-sc-${scUserId}`;
    const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 400);
  });
});

test('GET .../scan-lookup returns 404 for a well-formed code with no matching registration', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const staffUserId = await makeUser('admin');
    const cookie = `session=${(await createSession(staffUserId)).token}`;

    const code = `P17/2027-sc-${crypto.randomUUID()}`;
    const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('GET .../scan-lookup rejects a group without checkin menu access', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const scUserId = await makeUser('sc');
    const cookie = `session=${(await createSession(scUserId)).token}`;

    const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=P17/2027-sc-${scUserId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 403);
  });
});

test.after(async () => {
  await query("DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'scan-lookup-%')");
  await query("DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'scan-lookup-%')");
  await query("DELETE FROM users WHERE email LIKE 'scan-lookup-%'");
  await query("DELETE FROM events WHERE name = 'Scan Test Event'");
  await closePool();
});
