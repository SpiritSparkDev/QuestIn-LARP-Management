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

async function makeUser(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Eltern', 'Teil', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`children-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

const json = (cookie, method, body) => ({ method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

async function makeChild(port, guardian, isChild = true) {
  const res = await fetch(`http://localhost:${port}/managed-persons`, json(guardian.cookie, 'POST', { firstName: 'Klein', lastName: 'Kind', isChild }));
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

async function makeEvent(total = null) {
  const { rows } = await query("INSERT INTO events (name, event_date, is_active, capacity) VALUES ('Kinder-Con', '2027-09-01', true, $1) RETURNING id", [total]);
  return rows[0].id;
}

const registerSelf = (port, eventId, user) => fetch(`http://localhost:${port}/events/${eventId}/register`, json(user.cookie, 'POST', { conRole: 'sc' }));
const registerChild = (port, eventId, guardian, childId) => fetch(`http://localhost:${port}/managed-persons/${childId}/events/${eventId}/register`, json(guardian.cookie, 'POST', { conRole: 'sc' }));
const statusOf = async (eventId, userId) => (await query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0]?.status;

test.beforeEach(async () => {
  // Other test files delete the settings row; make sure there is one to switch the add-on on in.
  await query('INSERT INTO app_settings (id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM app_settings)');
  await query("UPDATE app_settings SET children_enabled = true, children_count_capacity = false, capacity_counted_roles = '{sc,nsc,ticket}'");
});
test.after(async () => {
  await query('UPDATE app_settings SET children_enabled = false, children_count_capacity = false');
});

test('a managed person can be marked as a child; releasing them drops the mark', async () => {
  await withTestServer(async (port) => {
    const guardian = await makeUser();
    const childId = await makeChild(port, guardian);
    const list = await (await fetch(`http://localhost:${port}/managed-persons`, { headers: { Cookie: guardian.cookie } })).json();
    assert.equal(list.find((p) => p.id === childId).isChild, true);

    const patched = await fetch(`http://localhost:${port}/managed-persons/${childId}`, json(guardian.cookie, 'PATCH', { isChild: 'ja' }));
    assert.equal(patched.status, 400);

    assert.equal((await fetch(`http://localhost:${port}/managed-persons/${childId}/release`, json(guardian.cookie, 'POST'))).status, 200);
    assert.equal((await query('SELECT is_child FROM users WHERE id = $1', [childId])).rows[0].is_child, false);
  });
});

test('a child can only be registered while the guardian is registered for the same event', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const guardian = await makeUser();
    const childId = await makeChild(port, guardian);

    const refused = await registerChild(port, eventId, guardian, childId);
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /Elternteil/);

    assert.equal((await registerSelf(port, eventId, guardian)).status, 201);
    assert.equal((await registerChild(port, eventId, guardian, childId)).status, 201);

    // A managed person who is not a child is not bound to the manager's registration.
    const other = await makeUser();
    const adultId = await makeChild(port, other, false);
    assert.equal((await registerChild(port, eventId, other, adultId)).status, 201);
  });
});

test('with the add-on off, the guardian rule does not apply', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const guardian = await makeUser();
    const childId = await makeChild(port, guardian);
    await query('UPDATE app_settings SET children_enabled = false');
    assert.equal((await registerChild(port, eventId, guardian, childId)).status, 201);
  });
});

test('children take no place in the participant limit unless the add-on says so', async () => {
  await withTestServer(async (port) => {
    // Not counted: the event (1 place) is full with the guardian, the child still gets in.
    const eventId = await makeEvent(1);
    const guardian = await makeUser();
    const childId = await makeChild(port, guardian);
    assert.equal((await registerSelf(port, eventId, guardian)).status, 201);
    assert.equal((await registerChild(port, eventId, guardian, childId)).status, 201);
    assert.equal(await statusOf(eventId, childId), 'pending');
    const late = await makeUser();
    assert.equal((await registerSelf(port, eventId, late)).status, 201);
    assert.equal(await statusOf(eventId, late.userId), 'waitlisted');

    // Counted: the next child on a full event waits like everyone else.
    await query('UPDATE app_settings SET children_count_capacity = true');
    const fullEvent = await makeEvent(1);
    const guardian2 = await makeUser();
    const child2 = await makeChild(port, guardian2);
    assert.equal((await registerSelf(port, fullEvent, guardian2)).status, 201);
    assert.equal((await registerChild(port, fullEvent, guardian2, child2)).status, 201);
    assert.equal(await statusOf(fullEvent, child2), 'waitlisted');

    // Switching counting off again lets the waiting child move up.
    const admin = await makeUser('admin');
    const res = await fetch(`http://localhost:${port}/app-settings`, json(admin.cookie, 'PUT', { childrenCountCapacity: false }));
    assert.equal(res.status, 200);
    assert.equal(await statusOf(fullEvent, child2), 'pending');
  });
});

test('GET /members and the check-in list show who is a child and who their guardian is', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const admin = await makeUser('admin');
    const guardian = await makeUser();
    const childId = await makeChild(port, guardian);
    await registerSelf(port, eventId, guardian);
    await registerChild(port, eventId, guardian, childId);

    const members = await (await fetch(`http://localhost:${port}/members`, { headers: { Cookie: admin.cookie } })).json();
    assert.equal(members.find((m) => m.id === childId).isChild, true);
    assert.equal(members.find((m) => m.id === guardian.userId).isChild, false);

    const participants = await (await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: admin.cookie } })).json();
    const child = participants.find((p) => p.userId === childId);
    assert.equal(child.isChild, true);
    assert.equal(child.guardianName, 'Eltern Teil');

    // Staff can correct the mark, but only on managed persons.
    assert.equal((await fetch(`http://localhost:${port}/members/${childId}`, json(admin.cookie, 'PATCH', { isChild: false }))).status, 200);
    assert.equal((await query('SELECT is_child FROM users WHERE id = $1', [childId])).rows[0].is_child, false);
    assert.equal((await fetch(`http://localhost:${port}/members/${guardian.userId}`, json(admin.cookie, 'PATCH', { isChild: true }))).status, 200);
    assert.equal((await query('SELECT is_child FROM users WHERE id = $1', [guardian.userId])).rows[0].is_child, false);
  });
});

test.after(async () => {
  await closePool();
});
