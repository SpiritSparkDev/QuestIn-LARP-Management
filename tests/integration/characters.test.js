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

async function makeUserAndSession(groupKey = 'sc') {
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

test('creating a character validates against the event schema', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const eventId = await makeEvent();

    const missingRequired = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId, name: 'Aldric', data: {} }),
    });
    assert.equal(missingRequired.status, 400);

    const ok = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId, name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    assert.equal(ok.status, 201);
    const created = await ok.json();
    assert.equal(created.name, 'Aldric');

    const unknownEvent = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId: crypto.randomUUID(), name: 'Ghost', data: {} }),
    });
    assert.equal(unknownEvent.status, 404);
  });
});

test('a participant only sees their own characters in the list', async () => {
  await withTestServer(async (port) => {
    const alice = await makeUserAndSession();
    const bob = await makeUserAndSession();
    const eventId = await makeEvent([]);

    await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
      body: JSON.stringify({ eventId, name: 'Alice Char', data: {} }),
    });
    await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
      body: JSON.stringify({ eventId, name: 'Bob Char', data: {} }),
    });

    const aliceList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: alice.cookie } })).json();
    assert.ok(aliceList.every((c) => c.name !== 'Bob Char'));
    assert.ok(aliceList.some((c) => c.name === 'Alice Char'));
  });
});

test('a participant cannot view or edit another participant\'s character; an admin can view but not edit it', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const admin = await makeUserAndSession('admin');
    const eventId = await makeEvent([]);

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ eventId, name: 'Owned', data: {} }),
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
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    assert.equal(adminPut.status, 403);

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
      body: JSON.stringify({ eventId, name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    const { id } = await createRes.json();

    const invalidPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ data: {} }),
    });
    assert.equal(invalidPut.status, 400);

    const validPut = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ data: { fraction: 'Valid Value' } }),
    });
    assert.equal(validPut.status, 200);
    const updated = await validPut.json();
    assert.deepEqual(updated.data, { fraction: 'Valid Value' });
  });
});

test('a participant cannot create a character for an inactive event; an admin can', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const admin = await makeUserAndSession('admin');
    const inactiveEventId = await makeEvent([], false);

    const asParticipant = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId: inactiveEventId, name: 'Blocked', data: {} }),
    });
    assert.equal(asParticipant.status, 403);

    const asAdmin = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ eventId: inactiveEventId, name: 'AdminOverride', data: {} }),
    });
    assert.equal(asAdmin.status, 201);
  });
});

test('an sl-group user cannot create a character for an inactive event', async () => {
  await withTestServer(async (port) => {
    const sl = await makeUserAndSession('sl');
    const inactiveEventId = await makeEvent([], false);

    const asSl = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sl.cookie },
      body: JSON.stringify({ eventId: inactiveEventId, name: 'Blocked', data: {} }),
    });
    assert.equal(asSl.status, 403);
  });
});

test('creating an nsc-class character validates against the current nsc_profile_schema, not an event', async () => {
  await withTestServer(async (port) => {
    const nscUser = await makeUserAndSession('nsc');

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
    assert.equal(created.event_id, null);
  });
});

test('an nsc-class character request with an eventId is rejected', async () => {
  await withTestServer(async (port) => {
    const nscUser = await makeUserAndSession('nsc');
    const eventId = await makeEvent([]);

    const res = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ class: 'nsc', eventId, name: 'Invalid', data: {} }),
    });
    assert.equal(res.status, 400);
  });
});

test('a group without nsc character-class access cannot create an nsc-class character', async () => {
  await withTestServer(async (port) => {
    const scUser = await makeUserAndSession('sc');

    const res = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: scUser.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Not Allowed', data: {} }),
    });
    assert.equal(res.status, 403);
  });
});

test('a user can create multiple sc-class characters for the same event (Ersatzcharaktere)', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const eventId = await makeEvent([]);

    const first = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId, name: 'Hauptcharakter', data: {} }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId, name: 'Ersatzcharakter', data: {} }),
    });
    assert.equal(second.status, 201);

    const list = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: participant.cookie } })).json();
    assert.equal(list.filter((c) => c.event_id === eventId).length, 2);
  });
});

test('PUT on an nsc-class character validates against the current nsc_profile_schema', async () => {
  await withTestServer(async (port) => {
    const nscUser = await makeUserAndSession('nsc');

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

test.after(async () => {
  await closePool();
});
