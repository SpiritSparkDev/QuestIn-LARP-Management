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

async function makeUserAndSession(groupKey = 'mitglied', firstName = 'Lodging') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, $3, 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`lodging-${crypto.randomUUID()}@example.com`, groupKey, firstName]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('lodging add-on: setup, booking, sold-out, visibility, switching and locks', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const json = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });
    const admin = await makeUserAndSession('admin');
    const alice = await makeUserAndSession('mitglied', 'Alice');
    const bob = await makeUserAndSession('mitglied', 'Bob');
    const carol = await makeUserAndSession('mitglied', 'Carol');

    const { rows: eventRows } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Lodging Con', '2099-08-01', true) RETURNING id");
    const eventId = eventRows[0].id;
    const putLodgings = (cookie, lodgings) => fetch(`${base}/events/${eventId}/lodgings`, { method: 'PUT', headers: json(cookie), body: JSON.stringify({ lodgings }) });
    const getLodgings = (cookie) => fetch(`${base}/events/${eventId}/lodgings`, { headers: json(cookie) });

    // Add-on off: nothing is available.
    assert.equal((await getLodgings(alice.cookie)).status, 404);
    assert.equal((await putLodgings(admin.cookie, [])).status, 404);

    const on = await fetch(`${base}/app-settings`, { method: 'PUT', headers: json(admin.cookie), body: JSON.stringify({ lodgingEnabled: true }) });
    assert.equal(on.status, 200);

    assert.equal((await putLodgings(alice.cookie, [])).status, 403);
    assert.equal((await putLodgings(admin.cookie, [{ name: 'X', beds: 0 }])).status, 400);
    const created = await putLodgings(admin.cookie, [{ name: 'Hütte Eiche', description: 'Mit Ofen', beds: 2, priceCents: 1500 }, { name: 'Zelt Blau', beds: 1 }]);
    assert.equal(created.status, 200);
    const [hut, tent] = await created.json();
    assert.equal(hut.free, 2);
    assert.equal(tent.priceCents, 0);

    const register = (cookie, lodgingId) => fetch(`${base}/events/${eventId}/register`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ conRole: 'helfer', lodgingId }),
    });
    assert.equal((await register(alice.cookie, crypto.randomUUID())).status, 400);
    const aliceReg = await register(alice.cookie, hut.id);
    assert.equal(aliceReg.status, 201);
    assert.equal((await register(bob.cookie, hut.id)).status, 201);
    const full = await register(carol.cookie, hut.id);
    assert.equal(full.status, 409);
    assert.match((await full.json()).error, /voll/);
    const due = async (userId) => (await query('SELECT amount_due_cents, lodging_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0];
    assert.deepEqual(await due(alice.userId), { amount_due_cents: 1500, lodging_cents: 1500 });

    // Beds and names are visible to every logged-in user, registered or not.
    const aliceView = await (await getLodgings(alice.cookie)).json();
    assert.deepEqual(aliceView[0].occupants.map((o) => o.name).sort(), ['Alice Test', 'Bob Test']);
    const carolView = await (await getLodgings(carol.cookie)).json();
    assert.equal(carolView[0].free, 0);
    assert.deepEqual(carolView[0].occupants.map((o) => o.name).sort(), ['Alice Test', 'Bob Test']);

    // Switching frees the bed and moves the price.
    const put = (cookie, userId, lodgingId) => fetch(`${base}/events/${eventId}/registrations/${userId}/lodging`, {
      method: 'PUT', headers: json(cookie), body: JSON.stringify({ lodgingId }),
    });
    assert.equal((await put(carol.cookie, alice.userId, tent.id)).status, 403);
    assert.equal((await put(alice.cookie, alice.userId, tent.id)).status, 200);
    assert.deepEqual(await due(alice.userId), { amount_due_cents: 0, lodging_cents: 0 });
    assert.equal((await (await getLodgings(admin.cookie)).json())[0].free, 1);

    // An occupied lodging can't be removed or shrunk below its occupants.
    assert.equal((await putLodgings(admin.cookie, [{ id: hut.id, name: 'Hütte Eiche', beds: 2, priceCents: 1500 }])).status, 409);
    assert.equal((await putLodgings(admin.cookie, [{ id: tent.id, name: 'Zelt Blau', beds: 1 }, { id: hut.id, name: 'Hütte Eiche', beds: 0, priceCents: 1500 }])).status, 400);
    const renamed = await putLodgings(admin.cookie, [{ id: hut.id, name: 'Eiche', beds: 3, priceCents: 1500 }, { id: tent.id, name: 'Zelt Blau', beds: 1 }]);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json())[0].free, 2);

    // Paid registrations can't move to a lodging with a different price.
    await query('UPDATE registrations SET paid_at = now() WHERE event_id = $1 AND user_id = $2', [eventId, alice.userId]);
    assert.equal((await put(alice.cookie, alice.userId, hut.id)).status, 409);

    // The participants list carries the lodging name.
    const participants = await (await fetch(`${base}/events/${eventId}/participants`, { headers: json(admin.cookie) })).json();
    assert.equal(participants.find((p) => p.userId === bob.userId).lodgingName, 'Eiche');
  });
});

test.after(async () => {
  await query("DELETE FROM events WHERE name = 'Lodging Con'");
  await query("DELETE FROM users WHERE email LIKE 'lodging-%'");
  await query('DELETE FROM app_settings');
  await closePool();
});
