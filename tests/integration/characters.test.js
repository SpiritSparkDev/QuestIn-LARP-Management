import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { createServer } = await import('../../backend/server.js');
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(role = 'participant') {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Char Test', $2, true) RETURNING id",
    [`chars-${role}-${crypto.randomUUID()}@example.com`, role]
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
  const server = createServer().listen(0);
  const { port } = server.address();
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

  server.close();
});

test('a participant only sees their own characters in the list', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
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

  server.close();
});

test('a participant cannot view or edit another participant\'s character; an admin can view but not edit it', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
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
  assert.equal(strangerGet.status, 403);

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

  server.close();
});

test('PUT /characters/:id validates data against the event schema', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
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

  server.close();
});

test('a participant cannot create a character for an inactive event; an admin can', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
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

  server.close();
});

test.after(async () => {
  await closePool();
});
