import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { createServer } = await import('../../backend/server.js');
const { query, closePool } = await import('../../backend/db.js');

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Events Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`events-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('admin can create an event; participant cannot', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const participant = await makeUserAndSession('sc');
  const payload = {
    name: 'Sommercon 2027',
    eventDate: '2027-07-15',
    characterFormSchema: [{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }],
  };

  const asAdmin = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify(payload),
  });
  assert.equal(asAdmin.status, 201);
  const created = await asAdmin.json();
  assert.equal(created.name, 'Sommercon 2027');
  assert.equal(created.event_date, '2027-07-15');

  const asParticipant = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify(payload),
  });
  assert.equal(asParticipant.status, 403);

  server.close();
});

test('any authenticated user can list and get events; unknown id is 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const participant = await makeUserAndSession('sc');

  const createRes = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Wintercon', eventDate: '2027-01-10', characterFormSchema: [] }),
  });
  const { id } = await createRes.json();

  const listRes = await fetch(`http://localhost:${port}/events`, { headers: { Cookie: participant.cookie } });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.some((e) => e.id === id));

  const getRes = await fetch(`http://localhost:${port}/events/${id}`, { headers: { Cookie: participant.cookie } });
  assert.equal(getRes.status, 200);

  const missingRes = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}`, { headers: { Cookie: participant.cookie } });
  assert.equal(missingRes.status, 404);

  server.close();
});

test('admin can update an event\'s character form schema', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');

  const createRes = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Frühlingscon', eventDate: '2027-04-01', characterFormSchema: [] }),
  });
  const { id } = await createRes.json();

  const newSchema = [{ key: 'weapon', label: 'Waffe', type: 'text', required: false }];
  const updateRes = await fetch(`http://localhost:${port}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ characterFormSchema: newSchema }),
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.deepEqual(updated.character_form_schema, newSchema);
  assert.equal(updated.name, 'Frühlingscon');

  server.close();
});

test('admin creating an event with a malformed characterFormSchema gets 400', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');

  const notAnArray = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Bad Schema Con', eventDate: '2027-08-01', characterFormSchema: { not: 'an array' } }),
  });
  assert.equal(notAnArray.status, 400);

  const missingKey = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Bad Schema Con 2', eventDate: '2027-08-01', characterFormSchema: [{ label: 'no key' }] }),
  });
  assert.equal(missingKey.status, 400);

  server.close();
});

test('GET /events/:id with a malformed UUID returns 400, not 500', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const participant = await makeUserAndSession();

  const res = await fetch(`http://localhost:${port}/events/not-a-valid-uuid`, {
    headers: { Cookie: participant.cookie },
  });
  assert.equal(res.status, 400);

  server.close();
});

test('admin can activate an event; activating one deactivates all others; participant cannot activate', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const participant = await makeUserAndSession('sc');

  async function createEvent(name) {
    const res = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name, eventDate: '2027-10-01', characterFormSchema: [] }),
    });
    return res.json();
  }

  const eventA = await createEvent('Herbstcon A');
  const eventB = await createEvent('Herbstcon B');

  const activateA = await fetch(`http://localhost:${port}/events/${eventA.id}/activate`, {
    method: 'POST', headers: { Cookie: admin.cookie },
  });
  assert.equal(activateA.status, 200);
  assert.equal((await activateA.json()).is_active, true);

  const activateB = await fetch(`http://localhost:${port}/events/${eventB.id}/activate`, {
    method: 'POST', headers: { Cookie: admin.cookie },
  });
  assert.equal(activateB.status, 200);
  assert.equal((await activateB.json()).is_active, true);

  const getA = await fetch(`http://localhost:${port}/events/${eventA.id}`, { headers: { Cookie: admin.cookie } });
  assert.equal((await getA.json()).is_active, false);

  const asParticipant = await fetch(`http://localhost:${port}/events/${eventA.id}/activate`, {
    method: 'POST', headers: { Cookie: participant.cookie },
  });
  assert.equal(asParticipant.status, 403);

  const unknownEvent = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/activate`, {
    method: 'POST', headers: { Cookie: admin.cookie },
  });
  assert.equal(unknownEvent.status, 404);

  server.close();
});

test('PUT /events/:id rejects a characterFormSchema using the reserved key "id" or "name"', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const createRes = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Schema Test Con', eventDate: '2027-08-01' }),
  });
  const { id } = await createRes.json();

  const withId = await fetch(`http://localhost:${port}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ characterFormSchema: [{ key: 'id', label: 'Id', type: 'text' }] }),
  });
  assert.equal(withId.status, 400);

  const withDuplicate = await fetch(`http://localhost:${port}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ characterFormSchema: [
      { key: 'klasse', label: 'Klasse', type: 'text' },
      { key: 'klasse', label: 'Klasse (2)', type: 'text' },
    ] }),
  });
  assert.equal(withDuplicate.status, 400);

  server.close();
});

test.after(async () => {
  await closePool();
});
