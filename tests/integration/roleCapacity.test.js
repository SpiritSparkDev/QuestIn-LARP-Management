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

const TAG = 'rolecap';

async function makeUser(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Cap', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`${TAG}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

async function makeEvent(limits) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, is_active, capacity, sc_capacity, nsc_capacity, sc_hard_capacity, nsc_hard_capacity)
     VALUES ('Role Cap Con', '2027-08-01', true, $1, $2, $3, $4, $5) RETURNING id`,
    [limits.total ?? null, limits.sc ?? null, limits.nsc ?? null, limits.scHard ?? null, limits.nscHard ?? null]
  );
  return rows[0].id;
}

const statusOf = async (eventId, userId) => (await query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0]?.status;

async function register(port, eventId, user, conRole) {
  const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: user.cookie }, body: JSON.stringify({ conRole }),
  });
  assert.equal(res.status, 201, `${conRole} registration failed`);
  return statusOf(eventId, user.userId);
}

test.beforeEach(async () => {
  await query("UPDATE app_settings SET capacity_counted_roles = '{sc,nsc,ticket}'");
});

test('SC and NSC have their own limit next to the total; a waiting person only moves up where their limit has room', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent({ total: 3, sc: 2, nsc: 1 });
    const [a, b, c, d, e] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser(), makeUser()]);

    assert.equal(await register(port, eventId, a, 'sc'), 'pending');
    assert.equal(await register(port, eventId, b, 'sc'), 'pending');
    assert.equal(await register(port, eventId, c, 'sc'), 'waitlisted'); // SC limit (2) reached, total still has room
    assert.equal(await register(port, eventId, d, 'nsc'), 'pending'); // 3rd place overall
    assert.equal(await register(port, eventId, e, 'nsc'), 'waitlisted'); // NSC limit and total both full

    // An SC leaves: only the waiting SC moves up, the waiting NSC stays (the NSC limit and the total are full again)
    const left = await fetch(`http://localhost:${port}/events/${eventId}/register`, { method: 'DELETE', headers: { Cookie: a.cookie } });
    assert.equal(left.status, 200);
    assert.equal(await statusOf(eventId, c.userId), 'pending');
    assert.equal(await statusOf(eventId, e.userId), 'waitlisted');
  });
});

test('crew roles do not count by default; the admin can make a role count', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent({ total: 1 });
    const staff = await makeUser('admin');
    const [first, helper, second] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    assert.equal(await register(port, eventId, first, 'sc'), 'pending');
    // the event is full, but a helper does not count
    assert.equal(await register(port, eventId, helper, 'helfer'), 'pending');
    assert.equal(await register(port, eventId, second, 'sc'), 'waitlisted');

    // not an admin: no access to the setting
    const denied = await fetch(`http://localhost:${port}/admin/settings/capacity-roles`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: first.cookie }, body: JSON.stringify({ roles: ['sc'] }) });
    assert.equal(denied.status, 403);
    const invalid = await fetch(`http://localhost:${port}/admin/settings/capacity-roles`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie }, body: JSON.stringify({ roles: ['sc', 'koenig'] }) });
    assert.equal(invalid.status, 400);

    // Helpers count too now: the waiting SC does not move up, the place is still taken
    const ok = await fetch(`http://localhost:${port}/admin/settings/capacity-roles`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie }, body: JSON.stringify({ roles: ['sc', 'nsc', 'ticket', 'helfer'] }) });
    assert.equal(ok.status, 200);
    const late = await makeUser();
    assert.equal(await register(port, eventId, late, 'helfer'), 'waitlisted');
  });
});

test('an admin turning an SC into an NSC: the NSC limit is checked and the SC place is freed for the waitlist', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent({ sc: 1, nsc: 1 });
    const admin = await makeUser('admin');
    const [sc, nsc, waitingSc] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    assert.equal(await register(port, eventId, sc, 'sc'), 'pending');
    assert.equal(await register(port, eventId, nsc, 'nsc'), 'pending');
    assert.equal(await register(port, eventId, waitingSc, 'sc'), 'waitlisted');

    const change = (user, conRole) => fetch(`http://localhost:${port}/events/${eventId}/registrations/${user.userId}/con-role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: JSON.stringify({ conRole }),
    });
    // NSC limit (1) is taken: no change, nothing moves
    const refused = await change(sc, 'nsc');
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /NSC/);
    assert.equal((await query('SELECT con_role FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, sc.userId])).rows[0].con_role, 'sc');
    assert.equal(await statusOf(eventId, waitingSc.userId), 'waitlisted');

    // The NSC leaves; now the SC may become NSC and the waiting SC takes the freed SC place
    await fetch(`http://localhost:${port}/events/${eventId}/register`, { method: 'DELETE', headers: { Cookie: nsc.cookie } });
    assert.equal((await change(sc, 'nsc')).status, 200);
    assert.equal(await statusOf(eventId, waitingSc.userId), 'pending');
  });
});

test('events accept and validate the SC / NSC limits', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const post = (body) => fetch(`http://localhost:${port}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: JSON.stringify({ name: 'Limits Con', eventDate: '2027-09-01', ...body }) });
    assert.equal((await post({ scCapacity: 0 })).status, 400);
    assert.equal((await post({ nscHardCapacity: 5 })).status, 400); // hard limit needs planned places
    assert.equal((await post({ scCapacity: 10, scHardCapacity: 8 })).status, 400);
    const created = await post({ capacity: 100, scCapacity: 60, scHardCapacity: 65, nscCapacity: 20 });
    assert.equal(created.status, 201);
    const event = await created.json();
    assert.equal(event.sc_capacity, 60);
    assert.equal(event.sc_hard_capacity, 65);
    assert.equal(event.nsc_capacity, 20);
    assert.equal(event.nsc_hard_capacity, null);

    const put = (body) => fetch(`http://localhost:${port}/events/${event.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: JSON.stringify(body) });
    const cleared = await (await put({ scCapacity: null, scHardCapacity: null })).json();
    assert.equal(cleared.sc_capacity, null);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'rolecap-%'");
  await query("DELETE FROM events WHERE name IN ('Role Cap Con', 'Limits Con')");
  await query("UPDATE app_settings SET capacity_counted_roles = '{sc,nsc,ticket}'");
  await closePool();
});
