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

async function makeEvent(schema = [{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }], isActive = true) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, character_form_schema, is_active)
     VALUES ('Char Test Con', '2027-05-01', $1, $2) RETURNING id`,
    [JSON.stringify(schema), isActive]
  );
  return rows[0].id;
}

test('creating a character only requires a name; event-scoped data is validated via PUT with eventId', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const eventId = await makeEvent();

    const created = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const missingRequired = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId, data: {} }),
    });
    assert.equal(missingRequired.status, 400);

    const ok = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId, data: { fraction: 'Nordmark' } }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).data, { fraction: 'Nordmark' });

    const unknownEvent = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId: crypto.randomUUID(), data: {} }),
    });
    assert.equal(unknownEvent.status, 404);
  });
});

test('a character\'s data accumulates fields across two events with different schemas', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const eventA = await makeEvent([{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }]);
    const eventB = await makeEvent([{ key: 'waffenklasse', label: 'Waffenklasse', type: 'text', required: true }]);

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    assert.equal(createRes.status, 201);
    const { id } = await createRes.json();

    const putA = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId: eventA, data: { fraction: 'Nordmark' } }),
    });
    assert.equal(putA.status, 200);
    assert.deepEqual((await putA.json()).data, { fraction: 'Nordmark' });

    const putB = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId: eventB, data: { waffenklasse: 'Schwert' } }),
    });
    assert.equal(putB.status, 200);
    assert.deepEqual((await putB.json()).data, { fraction: 'Nordmark', waffenklasse: 'Schwert' });
  });
});

test('PUT /characters/:id rejects an sc-class data update with no eventId', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ data: { fraction: 'Nordmark' } }),
    });
    assert.equal(res.status, 400);
  });
});

test('a participant only sees their own characters in the list', async () => {
  await withTestServer(async (port) => {
    const alice = await makeUserAndSession();
    const bob = await makeUserAndSession();

    await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
      body: JSON.stringify({ name: 'Alice Char' }),
    });
    await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
      body: JSON.stringify({ name: 'Bob Char' }),
    });

    const aliceList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: alice.cookie } })).json();
    assert.ok(aliceList.every((c) => c.name !== 'Bob Char'));
    assert.ok(aliceList.some((c) => c.name === 'Alice Char'));
  });
});

test('a participant cannot view or edit another participant\'s character; an admin (canOverrideCheckinStatus) can view and edit it', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Owned' }),
    });
    const { id } = await createRes.json();

    const strangerGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(strangerGet.status, 200);
    const strangerBody = await strangerGet.json();
    assert.deepEqual(strangerBody.data, {});

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

    const ownerPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    assert.equal(ownerPut.status, 200);
    assert.equal((await ownerPut.json()).name, 'Renamed');
  });
});

test('PUT /characters/:id validates data against the event schema', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const eventId = await makeEvent();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id } = await createRes.json();

    const invalidPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ eventId, data: {} }),
    });
    assert.equal(invalidPut.status, 400);

    const validPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ eventId, data: { fraction: 'Valid Value' } }),
    });
    assert.equal(validPut.status, 200);
    const updated = await validPut.json();
    assert.deepEqual(updated.data, { fraction: 'Valid Value' });
  });
});

test('creating an nsc-class character validates against the current nsc_profile_schema, not an event', async () => {
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
    const created = await ok.json();
    assert.equal(created.class, 'nsc');
  });
});

test('a user can create multiple sc-class characters (Ersatzcharaktere)', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const first = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Hauptcharakter' }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Ersatzcharakter' }),
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

test('PUT /characters/:id allows a canOverrideCheckinStatus group to edit another user\'s character', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const sl = await makeUserAndSession('moderator'); // moderator defaults to canOverrideCheckinStatus: true

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Fremdcharakter' }),
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
  await closePool();
});
