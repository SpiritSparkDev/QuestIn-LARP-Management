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

const { seedNscProfileSchema } = await import('../../db/seedNscProfileSchema.js');
await seedNscProfileSchema();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Char', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`chars-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent(isActive = true) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active) VALUES ('Char Test Con', '2027-05-01', $1) RETURNING id",
    [isActive]
  );
  return rows[0].id;
}

async function setScSchema(schema) {
  await query('UPDATE sc_character_schema SET schema = $1', [JSON.stringify(schema)]);
}

test.beforeEach(async () => {
  await setScSchema([{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }]);
});

test('creating an sc-class character validates data against the global sc schema at creation time', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const missingRequired = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: {} }),
    });
    assert.equal(missingRequired.status, 400);

    const ok = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    assert.equal(ok.status, 201);
    assert.deepEqual((await ok.json()).data, { fraction: 'Nordmark' });
  });
});

test('PUT /characters/:id replaces sc-class data (no merge, no eventId needed)', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const putRes = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ data: { fraction: 'Suedmark' } }),
    });
    assert.equal(putRes.status, 200);
    assert.deepEqual((await putRes.json()).data, { fraction: 'Suedmark' });
  });
});

test('POST /characters accepts isGsc for sc-class characters', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const res = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' }, isGsc: true }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).is_gsc, true);
  });
});

test('isGsc is ignored for nsc-class characters', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const res = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Elenwe', isGsc: true }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).is_gsc, false);
  });
});

test('PUT /characters/:id updates isGsc, and omitting it leaves the existing value unchanged', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' }, isGsc: true }),
    });
    const { id } = await createRes.json();

    const putRes = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ data: { fraction: 'Suedmark' } }),
    });
    assert.equal(putRes.status, 200);
    assert.equal((await putRes.json()).is_gsc, true);

    const clearRes = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ isGsc: false }),
    });
    assert.equal(clearRes.status, 200);
    assert.equal((await clearRes.json()).is_gsc, false);
  });
});

test('a participant only sees their own characters in the list', async () => {
  await withTestServer(async (port) => {
    const alice = await makeUserAndSession();
    const bob = await makeUserAndSession();

    await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
      body: JSON.stringify({ name: 'Alice Char', data: { fraction: 'Nordmark' } }),
    });
    await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
      body: JSON.stringify({ name: 'Bob Char', data: { fraction: 'Suedmark' } }),
    });

    const aliceList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: alice.cookie } })).json();
    assert.ok(aliceList.every((c) => c.name !== 'Bob Char'));
    assert.ok(aliceList.some((c) => c.name === 'Alice Char'));
  });
});

test('GET /characters lists registeredFor:null for an unused sc character and the event/role after registering', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const eventId = await makeEvent();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const beforeList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: participant.cookie } })).json();
    assert.equal(beforeList.find((c) => c.id === id).registeredFor, null);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: id }),
    });

    const afterList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: participant.cookie } })).json();
    const registered = afterList.find((c) => c.id === id).registeredFor;
    assert.equal(registered.eventId, eventId);
    assert.equal(registered.conRole, 'sc');
  });
});

test('a participant cannot view or edit another participant\'s character; an admin (canOverrideCheckinStatus) can view and edit it', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Owned', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const strangerGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(strangerGet.status, 200);
    // The global schema's one field has no `public: true` flag by default
    // in this test's setScSchema call, so a non-owner sees no data fields.
    assert.deepEqual((await strangerGet.json()).data, {});

    const adminGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: admin.cookie } });
    assert.equal(adminGet.status, 200);

    const strangerPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    assert.equal(strangerPut.status, 403);

    const adminPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Admin-Edit' }),
    });
    assert.equal(adminPut.status, 200);
    const adminUpdated = await adminPut.json();
    assert.equal(adminUpdated.name, 'Admin-Edit');
    assert.equal(adminUpdated.user_id, owner.userId);
  });
});

test('creating an nsc-class character validates against the current nsc_profile_schema, unaffected by the sc schema change', async () => {
  await withTestServer(async (port) => {
    const nscUser = await makeUserAndSession('mitglied');

    const missingRequired = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: { rollenAusruestung: ['NichtErlaubt'] } }),
    });
    assert.equal(missingRequired.status, 400);

    const ok = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: {} }),
    });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).class, 'nsc');
  });
});

test('a user can create multiple sc-class characters (Ersatzcharaktere)', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const first = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Hauptcharakter', data: { fraction: 'Nordmark' } }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Ersatzcharakter', data: { fraction: 'Suedmark' } }),
    });
    assert.equal(second.status, 201);

    const list = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: participant.cookie } })).json();
    assert.equal(list.filter((c) => c.class === 'sc').length, 2);
  });
});

test('PUT on an nsc-class character validates against the current nsc_profile_schema', async () => {
  await withTestServer(async (port) => {
    const nscUser = await makeUserAndSession('mitglied');

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: {} }),
    });
    const { id } = await createRes.json();

    const invalidPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ data: { rollenAusruestung: ['NichtErlaubt'] } }),
    });
    assert.equal(invalidPut.status, 400);

    const validPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ name: 'Wache Zwei' }),
    });
    assert.equal(validPut.status, 200);
    assert.equal((await validPut.json()).name, 'Wache Zwei');
  });
});

test('DELETE /characters/:id removes an unused character; owner-only; blocked once confirmed', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Deletable', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const strangerDelete = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'DELETE', headers: { Cookie: stranger.cookie },
    });
    assert.equal(strangerDelete.status, 403);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: id }),
    });
    await query("UPDATE registrations SET status = 'confirmed' WHERE character_id = $1", [id]);

    const blockedDelete = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'DELETE', headers: { Cookie: owner.cookie },
    });
    assert.equal(blockedDelete.status, 409);

    await query("UPDATE registrations SET status = 'pending' WHERE character_id = $1", [id]);
    await query('DELETE FROM registrations WHERE character_id = $1', [id]);

    const okDelete = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'DELETE', headers: { Cookie: owner.cookie },
    });
    assert.equal(okDelete.status, 200);

    const getAfterDelete = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: owner.cookie } });
    assert.equal(getAfterDelete.status, 404);
  });
});

test('PUT /characters/:id allows a canOverrideCheckinStatus group to edit another user\'s character', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const sl = await makeUserAndSession('moderator');

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Fremdcharakter', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const updateRes = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: sl.cookie },
      body: JSON.stringify({ name: 'Von SL bearbeitet' }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, 'Von SL bearbeitet');
    assert.equal(updated.user_id, owner.userId);
  });
});

test.after(async () => {
  await setScSchema([]);
  await closePool();
});
