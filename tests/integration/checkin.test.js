import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { createServer } = await import('../../backend/server.js');
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(role = 'participant') {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Checkin Test', $2, true) RETURNING id",
    [`checkin-${role}-${crypto.randomUUID()}@example.com`, role]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Checkin Test Con', '2027-09-01') RETURNING id"
  );
  return rows[0].id;
}

test('a participant cannot list participants or check anyone in', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { cookie } = await makeUserAndSession('participant');
  const eventId = await makeEvent();

  const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: cookie } });
  assert.equal(listRes.status, 403);

  const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ userId: crypto.randomUUID() }),
  });
  assert.equal(checkinRes.status, 403);

  server.close();
});

test('checkin_helper sees the participant list with characters and no encrypted fields, then checks someone in and out', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const helper = await makeUserAndSession('checkin_helper');
  const attendee = await makeUserAndSession('participant');
  const eventId = await makeEvent();

  await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);
  await query(
    "INSERT INTO characters (user_id, event_id, name, data) VALUES ($1, $2, 'Aldric', '{}')",
    [attendee.userId, eventId]
  );

  const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: helper.cookie } });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  const entry = list.find((p) => p.userId === attendee.userId);
  assert.ok(entry);
  assert.equal(entry.status, 'registered');
  assert.deepEqual(entry.characters.map((c) => c.name), ['Aldric']);
  assert.equal(JSON.stringify(entry).includes('_enc'), false);
  assert.equal('address' in entry, false);

  const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: attendee.userId }),
  });
  assert.equal(checkinRes.status, 200);
  assert.equal((await checkinRes.json()).status, 'checked_in');

  const doubleCheckinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: attendee.userId }),
  });
  assert.equal(doubleCheckinRes.status, 409);

  const checkoutRes = await fetch(`http://localhost:${port}/events/${eventId}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: attendee.userId }),
  });
  assert.equal(checkoutRes.status, 200);
  assert.equal((await checkoutRes.json()).status, 'checked_out');

  server.close();
});

test('checking in a user with no registration for the event returns 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const helper = await makeUserAndSession('checkin_helper');
  const stranger = await makeUserAndSession('participant');
  const eventId = await makeEvent();

  const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: stranger.userId }),
  });
  assert.equal(res.status, 404);

  server.close();
});

test.after(async () => {
  await closePool();
});
