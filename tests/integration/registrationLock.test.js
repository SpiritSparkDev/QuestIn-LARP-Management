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

const PREFIX = 'reg-lock-';
const events = [];

async function sessionFor(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Sper', 'Re', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`${PREFIX}${crypto.randomUUID()}@example.com`, groupKey]
  );
  return { id: rows[0].id, headers: { 'Content-Type': 'application/json', Cookie: `session=${(await createSession(rows[0].id)).token}` } };
}

async function makeEvent() {
  const { rows } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Sperr-Con', '2027-09-09', true) RETURNING id");
  events.push(rows[0].id);
  return rows[0].id;
}

const lock = (port, who, eventId, body) => fetch(`http://localhost:${port}/events/${eventId}/registration-lock`, { method: 'PUT', headers: who.headers, body: JSON.stringify(body) });
const register = (port, who, eventId) => fetch(`http://localhost:${port}/events/${eventId}/register`, {
  method: 'POST', headers: who.headers, body: JSON.stringify({ conRole: 'sc', waiverAccepted: true }),
});

test('a con-role lock refuses self-service registration but not an admin registering someone', async () => {
  await withTestServer(async (port) => {
    const admin = await sessionFor('admin');
    const member = await sessionFor('mitglied');
    const eventId = await makeEvent();

    assert.equal((await lock(port, admin, eventId, { conRoles: ['sc'], groups: [] })).status, 200);
    const refused = await register(port, member, eventId);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /als SC .* gesperrt/);

    const byAdmin = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${member.id}`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ conRole: 'sc' }),
    });
    assert.equal(byAdmin.status, 201);
  });
});

test('an account-role lock refuses that role until it is lifted', async () => {
  await withTestServer(async (port) => {
    const admin = await sessionFor('admin');
    const member = await sessionFor('mitglied');
    const eventId = await makeEvent();

    await lock(port, admin, eventId, { conRoles: [], groups: ['mitglied'] });
    const refused = await register(port, member, eventId);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /Rolle .* gesperrt/);

    await lock(port, admin, eventId, { conRoles: [], groups: [] });
    assert.equal((await register(port, member, eventId)).status, 201);
  });
});

test('only admins set the lock, and only known roles are accepted', async () => {
  await withTestServer(async (port) => {
    const admin = await sessionFor('admin');
    const moderator = await sessionFor('moderator');
    const eventId = await makeEvent();
    assert.equal((await lock(port, moderator, eventId, { conRoles: ['sc'] })).status, 403);
    assert.equal((await lock(port, admin, eventId, { conRoles: ['bogus'] })).status, 400);
    assert.equal((await lock(port, admin, eventId, { groups: ['bogus'] })).status, 400);
    const event = await (await fetch(`http://localhost:${port}/events/${eventId}`, { headers: admin.headers })).json();
    assert.deepEqual(event.registration_locked_con_roles, []);
  });
});

test('waitlist mode: a locked registration goes onto the waitlist and moves up once the lock is lifted', async () => {
  await withTestServer(async (port) => {
    await query('UPDATE app_settings SET waitlist_auto_promote = true');
    const admin = await sessionFor('admin');
    const member = await sessionFor('mitglied');
    const waitingByHand = await sessionFor('mitglied');
    const eventId = await makeEvent();
    await query("INSERT INTO registrations (user_id, event_id, con_role, status) VALUES ($1, $2, 'sc', 'waitlisted')", [waitingByHand.id, eventId]);

    assert.equal((await lock(port, admin, eventId, { conRoles: ['sc'], mode: 'waitlist' })).status, 200);
    const res = await register(port, member, eventId);
    assert.equal(res.status, 201);
    const statusOf = async (userId) => (await query('SELECT status, waitlisted_by_lock FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0];
    assert.deepEqual(await statusOf(member.id), { status: 'waitlisted', waitlisted_by_lock: true });

    await lock(port, admin, eventId, { conRoles: [], mode: 'waitlist' });
    assert.deepEqual(await statusOf(member.id), { status: 'pending', waitlisted_by_lock: false });
    assert.equal((await statusOf(waitingByHand.id)).status, 'waitlisted', 'a manual waitlist entry is not promoted by lifting the lock');
  });
});

test.after(async () => {
  await query('DELETE FROM registrations WHERE event_id = ANY($1)', [events]);
  await query('DELETE FROM events WHERE id = ANY($1)', [events]);
  await query('DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${PREFIX}%`]);
  await query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${PREFIX}%`]);
  await query('DELETE FROM users WHERE email LIKE $1', [`${PREFIX}%`]);
  await closePool();
});
