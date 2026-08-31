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

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Checkin', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`checkin-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
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
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('sc');
    const eventId = await makeEvent();

    const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 403);

    const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    assert.equal(checkinRes.status, 403);

    const checkoutRes = await fetch(`http://localhost:${port}/events/${eventId}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    assert.equal(checkoutRes.status, 403);
  });
});

test('checkin_helper sees the participant list with characters and no encrypted fields, then checks someone in and out', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('sl');
    const attendee = await makeUserAndSession('sc');
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

    const admin = await makeUserAndSession('admin');
    const adminListRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: admin.cookie } });
    assert.equal(adminListRes.status, 200);

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
  });
});

test('GET /events/:id/participants for an unknown event returns 404', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('sl');

    const res = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/participants`, {
      headers: { Cookie: helper.cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('checking in a user with no registration for the event returns 404', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('sl');
    const stranger = await makeUserAndSession('sc');
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: stranger.userId }),
    });
    assert.equal(res.status, 404);
  });
});

test('two concurrent check-ins for the same attendee: exactly one succeeds', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('sl');
    const attendee = await makeUserAndSession('sc');
    const eventId = await makeEvent();

    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const doCheckin = () => fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });

    const [resA, resB] = await Promise.all([doCheckin(), doCheckin()]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const okRes = resA.status === 200 ? resA : resB;
    assert.equal((await okRes.json()).status, 'checked_in');
  });
});

test('a user without canOverrideCheckinStatus cannot use the override endpoint', async () => {
  await withTestServer(async (port) => {
    // hilfs_sl has 'checkin' in visibleMenus (so the request reaches the handler)
    // but canOverrideCheckinStatus: false (so this test proves the override check
    // itself rejects it, not the pre-existing requireMenu('checkin') gate).
    const stranger = await makeUserAndSession('hilfs_sl');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [stranger.userId, eventId]);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${stranger.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ status: 'checked_in' }),
    });
    assert.equal(res.status, 403);
  });
});

test('a user with canOverrideCheckinStatus can set a status directly, including a backward transition', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('sc');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const toCheckedOut = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'checked_out', previousStatus: 'registered' }),
    });
    assert.equal(toCheckedOut.status, 200);
    const checkedOutBody = await toCheckedOut.json();
    assert.equal(checkedOutBody.status, 'checked_out');
    assert.equal(checkedOutBody.checked_in_at, null, 'skipping straight to checked_out must not fabricate checked_in_at');
    assert.ok(checkedOutBody.checked_out_at);

    const backToRegistered = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'registered', previousStatus: 'checked_out' }),
    });
    assert.equal(backToRegistered.status, 200);
    const registeredBody = await backToRegistered.json();
    assert.equal(registeredBody.status, 'registered');
    assert.equal(registeredBody.checked_in_at, null);
    assert.equal(registeredBody.checked_out_at, null);
  });
});

test('overriding to checked_out preserves an already-set checked_in_at instead of overwriting it', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('sl');
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('sc');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });
    assert.equal(checkinRes.status, 200);
    const { checked_in_at: originalCheckedInAt } = await checkinRes.json();
    assert.ok(originalCheckedInAt);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const overrideRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'checked_out', previousStatus: 'checked_in' }),
    });
    assert.equal(overrideRes.status, 200);
    const overrideBody = await overrideRes.json();
    assert.equal(overrideBody.status, 'checked_out');
    assert.equal(overrideBody.checked_in_at, originalCheckedInAt, 'checked_in_at set by the normal flow must survive the override');
  });
});

test('the override endpoint rejects an invalid status value', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('sc');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'nonsense' }),
    });
    assert.equal(res.status, 400);
  });
});

test('the override endpoint returns 404 for a user with no registration for the event', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const stranger = await makeUserAndSession('sc');
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${stranger.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'checked_in', previousStatus: 'registered' }),
    });
    assert.equal(res.status, 404);
  });
});

test('two concurrent overrides on the same registration with the same previousStatus: exactly one succeeds', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('sc');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const doOverride = (status) => fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status, previousStatus: 'registered' }),
    });

    const [resA, resB] = await Promise.all([doOverride('checked_in'), doOverride('checked_out')]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  });
});

test('the normal checkin/checkout flow still works unchanged alongside the override endpoint', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('sl');
    const attendee = await makeUserAndSession('sc');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });
    assert.equal(checkinRes.status, 200);
    assert.equal((await checkinRes.json()).status, 'checked_in');
  });
});

test('overriding directly from registered to checked_out does not fabricate a checked_in_at timestamp', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('sc');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const overrideRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'checked_out', previousStatus: 'registered' }),
    });
    assert.equal(overrideRes.status, 200);
    const overrideBody = await overrideRes.json();
    assert.equal(overrideBody.checked_in_at, null, 'check-in never happened, so checked_in_at must stay null');
    assert.ok(overrideBody.checked_out_at, 'checkout genuinely happened, so checked_out_at must be set');
  });
});

test.after(async () => {
  await closePool();
});
