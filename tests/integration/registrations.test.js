import { test } from 'node:test';
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

async function makeUserAndSession() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Reg', 'Test', (SELECT id FROM groups WHERE key = 'sc'), true) RETURNING id",
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
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assert.equal(registerRes.status, 201);
    const registration = await registerRes.json();
    assert.equal(registration.status, 'pending');

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
  });
});

test('registering for an unknown event returns 404', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();

    const res = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/register`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('unregistering without an existing registration returns 404', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('a checked-in participant cannot unregister', async () => {
  await withTestServer(async (port) => {
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
  });
});

test('concurrent approve and cancel never leave an inconsistent row', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const { rows: helperRows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Race', 'Helper', (SELECT id FROM groups WHERE key = 'sl'), true) RETURNING id",
      [`reg-helper-${crypto.randomUUID()}@example.com`]
    );
    const helperSession = await createSession(helperRows[0].id);
    const helperCookie = `session=${helperSession.token}`;
    const eventId = await makeEvent();

    const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assert.equal(registerRes.status, 201);
    await query(
      "INSERT INTO characters (user_id, event_id, name, data) VALUES ($1, $2, 'Aldric', '{}')",
      [userId, eventId]
    );

    const doApprove = () => fetch(`http://localhost:${port}/events/${eventId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helperCookie },
      body: JSON.stringify({ userId }),
    });
    const doCancel = () => fetch(`http://localhost:${port}/events/${eventId}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helperCookie },
      body: JSON.stringify({ userId }),
    });

    const [resA, resB] = await Promise.all([doApprove(), doCancel()]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const { rows } = await query(
      'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );
    assert.equal(rows.length, 1);
    assert.ok(['confirmed', 'cancelled'].includes(rows[0].status));
  });
});

test('GET /registrations lists only the calling participant\'s registrations', async () => {
  await withTestServer(async (port) => {
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
      assert.equal(r.status, 'pending');
    }
  });
});

test.after(async () => {
  await closePool();
});
