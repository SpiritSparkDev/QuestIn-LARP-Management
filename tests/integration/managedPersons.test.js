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

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createServer } = await import('../../backend/server.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Owner', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`managed-owner-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('POST /managed-persons creates a person owned by the caller, in the caller\'s own group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { userId: ownerId, cookie } = await makeUserAndSession('mitglied');

    const res = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'Kind' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.firstName, 'ManagedTestPerson');
    assert.equal(body.canDelete, true);

    const { rows } = await query(
      'SELECT is_guest, password_hash, managed_by_user_id, group_id FROM users WHERE id = $1',
      [body.id]
    );
    assert.equal(rows[0].is_guest, true);
    assert.equal(rows[0].password_hash, null);
    assert.equal(rows[0].managed_by_user_id, ownerId);
    const { rows: ownerRows } = await query('SELECT group_id FROM users WHERE id = $1', [ownerId]);
    assert.equal(rows[0].group_id, ownerRows[0].group_id);
  } finally {
    server.close();
  }
});

test('POST /managed-persons without email succeeds (email is optional)', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');

    const res = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'OhneMail' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.email, null);
  } finally {
    server.close();
  }
});

test('GET /managed-persons lists only the caller\'s own', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: cookieA } = await makeUserAndSession('mitglied');
    const { cookie: cookieB } = await makeUserAndSession('mitglied');

    await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'VonA' }),
    });

    const resB = await fetch(`http://localhost:${port}/managed-persons`, { headers: { Cookie: cookieB } });
    assert.equal(resB.status, 200);
    assert.deepEqual(await resB.json(), []);

    const resA = await fetch(`http://localhost:${port}/managed-persons`, { headers: { Cookie: cookieA } });
    const bodyA = await resA.json();
    assert.equal(bodyA.length, 1);
    assert.equal(bodyA[0].lastName, 'VonA');
  } finally {
    server.close();
  }
});

test('a foreign account cannot read, edit, or delete another account\'s managed person (404, not 403)', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');

    const createRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'Geheim' }),
    });
    const { id } = await createRes.json();

    const getRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { headers: { Cookie: strangerCookie } });
    assert.equal(getRes.status, 404);

    const patchRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ lastName: 'Uebernommen' }),
    });
    assert.equal(patchRes.status, 404);

    const deleteRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { method: 'DELETE', headers: { Cookie: strangerCookie } });
    assert.equal(deleteRes.status, 404);
  } finally {
    server.close();
  }
});

test('PATCH /managed-persons/:id rejects an OT field the caller isn\'t permitted to set themselves', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const createRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'Feld' }),
    });
    const { id } = await createRes.json();

    // 'mitglied' lacks 'medicalNotes' in its default accountFields (same
    // fixture assumption /members/invite's existing tests already rely on).
    const res = await fetch(`http://localhost:${port}/managed-persons/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ medicalNotes: 'sollte nicht ankommen' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('DELETE /managed-persons/:id succeeds with no registrations, 409s once one exists', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const createRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'LoeschTest' }),
    });
    const { id } = await createRes.json();

    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date) VALUES ('Managed Delete Test Event', '2026-01-01') RETURNING id"
    );
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role) VALUES ($1, $2, 'helfer')",
      [id, eventRows[0].id]
    );

    const blockedRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(blockedRes.status, 409);

    await query('DELETE FROM registrations WHERE user_id = $1', [id]);

    const okRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(okRes.status, 200);
    const { rows } = await query('SELECT 1 FROM users WHERE id = $1', [id]);
    assert.equal(rows.length, 0);
  } finally {
    server.close();
  }
});

test('an owner can upload/list/delete a file on their managed person\'s character', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'FileOwner' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: charRows } = await query(
      "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Managed File Char', '{}') RETURNING id",
      [managedId]
    );
    const characterId = charRows[0].id;
    const tinyPng = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

    const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ kind: 'image', filename: 'a.png', mimeType: 'image/png', dataBase64: tinyPng, gdprConsent: true }),
    });
    assert.equal(uploadRes.status, 201);
    const file = await uploadRes.json();

    const listRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, { headers: { Cookie: cookie } });
    assert.equal((await listRes.json()).length, 1);

    const deleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${file.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(deleteRes.status, 200);
  } finally {
    server.close();
  }
});

test('POST and GET /managed-persons/:id/characters creates and lists a character for the managed person', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'CharCreate' }),
    });
    const { id: managedId } = await personRes.json();

    const createRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ class: 'sc', name: 'Delegated Char', data: {} }),
    });
    assert.equal(createRes.status, 201);
    const character = await createRes.json();
    assert.equal(character.user_id, managedId);

    const listRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/characters`, { headers: { Cookie: cookie } });
    const list = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, character.id);
  } finally {
    server.close();
  }
});

test('a stranger gets 404 from /managed-persons/:id/characters, not another account\'s data', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'CharStranger2' }),
    });
    const { id: managedId } = await personRes.json();

    const res = await fetch(`http://localhost:${port}/managed-persons/${managedId}/characters`, { headers: { Cookie: strangerCookie } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM registrations WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Managed Delete Test%')");
  await query("DELETE FROM events WHERE name LIKE 'Managed Delete Test%'");
  await query("DELETE FROM users WHERE email LIKE 'managed-owner-%' OR first_name = 'ManagedTestPerson'");
  await closePool();
});
