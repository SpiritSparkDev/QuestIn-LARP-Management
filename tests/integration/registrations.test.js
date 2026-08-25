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

async function makeUserAndSession() {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Reg Test', 'participant', true) RETURNING id",
    [`reg-${crypto.randomUUID()}@example.com`]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Reg Test Con', '2027-08-01') RETURNING id"
  );
  return rows[0].id;
}

test('a participant can register and unregister for an event', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { userId, cookie } = await makeUserAndSession();
  const eventId = await makeEvent();

  const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(registerRes.status, 201);
  const registration = await registerRes.json();
  assert.equal(registration.status, 'registered');

  const dupRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(dupRes.status, 409);

  const unregisterRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(unregisterRes.status, 200);

  const { rows } = await query(
    'SELECT * FROM registrations WHERE user_id = $1 AND event_id = $2',
    [userId, eventId]
  );
  assert.equal(rows.length, 0);

  server.close();
});

test('registering for an unknown event returns 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { cookie } = await makeUserAndSession();

  const res = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(res.status, 404);

  server.close();
});

test('unregistering without an existing registration returns 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { cookie } = await makeUserAndSession();
  const eventId = await makeEvent();

  const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(res.status, 404);

  server.close();
});

test('a checked-in participant cannot unregister', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { userId, cookie } = await makeUserAndSession();
  const eventId = await makeEvent();

  await query(
    "INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'checked_in')",
    [userId, eventId]
  );

  const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(res.status, 409);

  server.close();
});

test.after(async () => {
  await closePool();
});
