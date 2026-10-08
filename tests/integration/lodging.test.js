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

    // Beds are visible to every logged-in user; real names are not -- only staff sees them.
    const aliceView = await (await getLodgings(alice.cookie)).json();
    assert.equal(aliceView[0].taken, 2);
    assert.deepEqual(aliceView[0].occupants, []);
    const carolView = await (await getLodgings(carol.cookie)).json();
    assert.equal(carolView[0].free, 0);
    assert.deepEqual(carolView[0].occupants, []);
    assert.deepEqual((await (await getLodgings(admin.cookie)).json())[0].occupants.map((o) => o.name).sort(), ['Alice Test', 'Bob Test']);
    // Someone who belongs to a group shows up with the character (IT) name only.
    const { rows: held } = await query("INSERT INTO characters (user_id, name) VALUES ($1, 'Bobs Held') RETURNING id", [bob.userId]);
    await query('UPDATE registrations SET character_id = $2, con_role = $4 WHERE event_id = $1 AND user_id = $3', [eventId, held[0].id, bob.userId, 'sc']);
    await query('UPDATE users SET group_parent_id = $1 WHERE id = $2', [carol.userId, bob.userId]);
    assert.deepEqual((await (await getLodgings(carol.cookie)).json())[0].occupants.map((o) => o.name), ['Bobs Held']);
    // ... but only people of the same group see that; an outsider doesn't.
    assert.deepEqual((await (await getLodgings(alice.cookie)).json())[0].occupants, []);
    await query('UPDATE users SET group_parent_id = NULL WHERE id = $1', [bob.userId]);

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

test('lodging add-on: free tent pitches need size and IT/OT, beds ignore tent details', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const json = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });
    const admin = await makeUserAndSession('admin');
    const dora = await makeUserAndSession('mitglied', 'Dora');
    const emil = await makeUserAndSession('mitglied', 'Emil');
    const { rows } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Pitch Con', '2099-08-01', true) RETURNING id");
    const eventId = rows[0].id;
    await fetch(`${base}/app-settings`, { method: 'PUT', headers: json(admin.cookie), body: JSON.stringify({ lodgingEnabled: true }) });
    const saved = await fetch(`${base}/events/${eventId}/lodgings`, {
      method: 'PUT', headers: json(admin.cookie),
      body: JSON.stringify({ lodgings: [{ name: 'Zeltwiese', kind: 'pitch', beds: 1, priceCents: 0, isDefault: true }, { name: 'Hütte', beds: 2 }, { name: 'Wiese', kind: 'pitch', beds: 0, priceCents: 500 }] }),
    });
    assert.equal(saved.status, 200);
    const [pitch, hut, meadow] = await saved.json();
    assert.deepEqual([pitch.isDefault, hut.isDefault, meadow.isDefault], [true, false, false]);
    const twoDefaults = await fetch(`${base}/events/${eventId}/lodgings`, {
      method: 'PUT', headers: json(admin.cookie),
      body: JSON.stringify({ lodgings: [{ id: pitch.id, name: 'Zeltwiese', kind: 'pitch', beds: 1, isDefault: true }, { id: hut.id, name: 'Hütte', beds: 2, isDefault: true }, { id: meadow.id, name: 'Wiese', kind: 'pitch', beds: 0, priceCents: 500 }] }),
    });
    assert.equal(twoDefaults.status, 400);
    // Moving the default to another lodging works in one save.
    const moved = await (await fetch(`${base}/events/${eventId}/lodgings`, {
      method: 'PUT', headers: json(admin.cookie),
      body: JSON.stringify({ lodgings: [{ id: pitch.id, name: 'Zeltwiese', kind: 'pitch', beds: 1 }, { id: hut.id, name: 'Hütte', beds: 2 }, { id: meadow.id, name: 'Wiese', kind: 'pitch', beds: 0, priceCents: 500, isDefault: true }] }),
    })).json();
    assert.deepEqual(moved.map((l) => l.isDefault), [false, false, true]);
    assert.equal(meadow.unlimited, true);
    assert.equal(meadow.free, null);
    assert.equal(pitch.kind, 'pitch');
    assert.equal(hut.kind, 'beds');

    const register = (cookie, lodgingId, lodgingDetails) => fetch(`${base}/events/${eventId}/register`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ conRole: 'helfer', lodgingId, lodgingDetails }),
    });
    assert.equal((await register(dora.cookie, pitch.id)).status, 400);
    assert.equal((await register(dora.cookie, pitch.id, { lengthCm: 400, widthCm: 300, tentType: 'xx' })).status, 400);
    const ok = await register(dora.cookie, pitch.id, { lengthCm: 400, widthCm: 300, tentType: 'it' });
    assert.equal(ok.status, 201);
    const stored = (await query('SELECT lodging_details, amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, dora.userId])).rows[0];
    assert.deepEqual(stored.lodging_details, { lengthCm: 400, widthCm: 300, tentType: 'it' });
    assert.equal(stored.amount_due_cents, null);

    // The one pitch is taken; the organisers see whose tent it is.
    assert.equal((await register(emil.cookie, pitch.id, { lengthCm: 200, widthCm: 200, tentType: 'ot' })).status, 409);
    const view = await (await fetch(`${base}/events/${eventId}/lodgings`, { headers: json(admin.cookie) })).json();
    assert.deepEqual(view[0].occupants[0].details, { lengthCm: 400, widthCm: 300, tentType: 'it' });

    // Tent details given for a bed are dropped.
    const bed = await register(emil.cookie, hut.id, { lengthCm: 200, widthCm: 200, tentType: 'ot' });
    assert.equal(bed.status, 201);
    assert.equal((await query('SELECT lodging_details FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, emil.userId])).rows[0].lodging_details, null);

    // A pitch with 0 places is unlimited; the size is optional but then needs both sides.
    const fritz = await makeUserAndSession('mitglied', 'Fritz');
    const gerd = await makeUserAndSession('mitglied', 'Gerd');
    assert.equal((await register(fritz.cookie, meadow.id, { tentType: 'ot', lengthCm: 300 })).status, 400);
    assert.equal((await register(fritz.cookie, meadow.id, { tentType: 'ot' })).status, 201);
    assert.equal((await register(gerd.cookie, meadow.id, { tentType: 'it', lengthCm: 500, widthCm: 400 })).status, 201);
    assert.equal((await query('SELECT amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, fritz.userId])).rows[0].amount_due_cents, 500);
    const meadowView = (await (await fetch(`${base}/events/${eventId}/lodgings`, { headers: json(emil.cookie) })).json())[2];
    assert.equal(meadowView.taken, 2);

    // The kind can't change while someone is in.
    const change = await fetch(`${base}/events/${eventId}/lodgings`, {
      method: 'PUT', headers: json(admin.cookie),
      body: JSON.stringify({ lodgings: [{ id: pitch.id, name: 'Zeltwiese', kind: 'beds', beds: 1 }, { id: hut.id, name: 'Hütte', beds: 2 }, { id: meadow.id, name: 'Wiese', kind: 'pitch', beds: 0, priceCents: 500 }] }),
    });
    assert.equal(change.status, 409);

    const participants = await (await fetch(`${base}/events/${eventId}/participants`, { headers: json(admin.cookie) })).json();
    assert.equal(participants.find((p) => p.userId === dora.userId).lodgingName, 'Zeltwiese (4,0 × 3,0 m, IT)');
  });
});

test.after(async () => {
  await query("DELETE FROM events WHERE name IN ('Lodging Con', 'Pitch Con')");
  await query("DELETE FROM users WHERE email LIKE 'lodging-%'");
  await query('DELETE FROM app_settings');
  await closePool();
});
