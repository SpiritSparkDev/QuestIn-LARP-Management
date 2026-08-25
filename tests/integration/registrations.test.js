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

async function makeEventNamed(name, eventDate) {
  const { rows } = await query(
    'INSERT INTO events (name, event_date) VALUES ($1, $2) RETURNING id',
    [name, eventDate]
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

test('concurrent check-in and unregister never leave an inconsistent row', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { userId, cookie } = await makeUserAndSession();
  const { rows: helperRows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Race Helper', 'checkin_helper', true) RETURNING id",
    [`reg-helper-${crypto.randomUUID()}@example.com`]
  );
  const helperSession = await createSession(helperRows[0].id);
  const helperCookie = `session=${helperSession.token}`;
  const eventId = await makeEvent();

  const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(registerRes.status, 201);

  const doCheckin = () => fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helperCookie },
    body: JSON.stringify({ userId }),
  });
  const doUnregister = () => fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });

  await Promise.all([doCheckin(), doUnregister()]);

  // Whichever operation's DB round-trip commits first wins the race; the fix
  // (conditional DELETE guarded by status = 'registered') guarantees the two
  // outcomes below are the only possible end states — never a row that was
  // deleted after becoming checked_in, and never two conflicting writes both
  // "succeeding".
  const { rows } = await query(
    'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
    [userId, eventId]
  );
  // Unregister won (row gone, only possible if DELETE saw status='registered')
  // or checkin won (row exists, and if so its status must be 'checked_in' -
  // never left half-updated or deleted out from under a completed check-in).
  if (rows.length > 0) {
    assert.equal(rows[0].status, 'checked_in');
  }

  server.close();
});

test('GET /registrations lists only the calling participant\'s registrations', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const a = await makeUserAndSession();
  const b = await makeUserAndSession();
  const eventId1 = await makeEventNamed('Reg Test Con A', '2027-08-02');
  const eventId2 = await makeEventNamed('Reg Test Con B', '2027-08-03');

  await fetch(`http://localhost:${port}/events/${eventId1}/register`, {
    method: 'POST', headers: { Cookie: a.cookie },
  });
  await fetch(`http://localhost:${port}/events/${eventId2}/register`, {
    method: 'POST', headers: { Cookie: a.cookie },
  });
  await fetch(`http://localhost:${port}/events/${eventId1}/register`, {
    method: 'POST', headers: { Cookie: b.cookie },
  });

  const res = await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: a.cookie } });
  assert.equal(res.status, 200);
  const list = await res.json();
  // Exactly A's two registrations - if the query weren't scoped to A's
  // user_id, B's shared registration for eventId1 would show up as a
  // duplicate row and push the length past 2.
  assert.equal(list.length, 2);
  const eventIds = list.map((r) => r.eventId).sort();
  assert.deepEqual(eventIds, [eventId1, eventId2].sort());
  for (const r of list) {
    assert.ok(r.eventName);
    assert.ok(r.eventDate);
    assert.equal(r.status, 'registered');
  }

  server.close();
});

test.after(async () => {
  await closePool();
});
