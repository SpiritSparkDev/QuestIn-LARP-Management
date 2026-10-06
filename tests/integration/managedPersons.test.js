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

test('DELETE /managed-persons/:id succeeds with open registrations, 409s once one is confirmed', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const createRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'LoeschTest' }),
    });
    let { id } = await createRes.json();

    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date) VALUES ('Managed Delete Test Event', '2026-01-01') RETURNING id"
    );
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role) VALUES ($1, $2, 'helfer')",
      [id, eventRows[0].id]
    );

    await query("UPDATE registrations SET status = 'confirmed' WHERE user_id = $1", [id]);
    const blockedRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(blockedRes.status, 409);

    const forcedRes = await fetch(`http://localhost:${port}/managed-persons/${id}?force=true`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(forcedRes.status, 200);
    const createRes2 = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'LoeschTest2' }),
    });
    id = (await createRes2.json()).id;
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role) VALUES ($1, $2, 'helfer')",
      [id, eventRows[0].id]
    );

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

test('POST/DELETE /managed-persons/:id/events/:eventId/register registers and unregisters the managed person', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'RegOwner' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Managed Register Test Event', '2026-02-01', true) RETURNING id"
    );
    const eventId = eventRows[0].id;

    const registerRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(registerRes.status, 201);
    const registration = await registerRes.json();
    assert.equal(registration.user_id, managedId);

    const listRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/registrations`, { headers: { Cookie: cookie } });
    const list = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].eventId, eventId);

    const unregisterRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/events/${eventId}/register`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(unregisterRes.status, 200);
  } finally {
    server.close();
  }
});

test('a stranger gets 404 attempting to register someone else\'s managed person', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'RegStranger' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Managed Register Stranger Event', '2026-02-02', true) RETURNING id"
    );

    const res = await fetch(`http://localhost:${port}/managed-persons/${managedId}/events/${eventRows[0].id}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /managed-persons/:id/convert sends an invitation, and redeeming it fully severs ownership', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'Convert', email: `managed-convert-${crypto.randomUUID()}@example.com` }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: charRows } = await query(
      "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Pre-Convert Char', '{}') RETURNING id",
      [managedId]
    );
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Managed Convert Test Event', '2026-03-01', true) RETURNING id"
    );
    const eventId = eventRows[0].id;
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role, amount_due_cents) VALUES ($1, $2, 'helfer', 1000)",
      [managedId, eventId]
    );

    const convertRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/convert`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(convertRes.status, 201);
    const { link } = await convertRes.json();
    const token = new URL(link).searchParams.get('token');

    const { rows: invRows } = await query('SELECT user_id, invited_by FROM invitations WHERE token = $1', [token]);
    assert.equal(invRows[0].user_id, managedId);

    const redeemRes = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'correct horse battery staple' }),
    });
    assert.equal(redeemRes.status, 200);

    const { rows } = await query('SELECT is_guest, managed_by_user_id FROM users WHERE id = $1', [managedId]);
    assert.equal(rows[0].is_guest, false);
    assert.equal(rows[0].managed_by_user_id, null);

    // The character created before conversion survives, and the former
    // owner has no special access to it any more now that ownership is gone.
    const ownerAccessRes = await fetch(`http://localhost:${port}/characters/${charRows[0].id}`, { headers: { Cookie: cookie } });
    assert.equal(ownerAccessRes.status, 200); // character's own public-field view, not the owner-view
    const body = await ownerAccessRes.json();
    assert.equal(body.id, charRows[0].id);
    // Unlike GET (same 200 status for owner and non-owner views), PUT
    // distinguishes them with a different status code -- the former owner
    // is now a plain non-owner, non-elevated caller, so this 403s.
    const ownerEditRes = await fetch(`http://localhost:${port}/characters/${charRows[0].id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Should not be allowed' }),
    });
    assert.equal(ownerEditRes.status, 403);
    // The former owner's /managed-persons list no longer includes this person.
    const listRes = await fetch(`http://localhost:${port}/managed-persons`, { headers: { Cookie: cookie } });
    assert.ok(!(await listRes.json()).some((p) => p.id === managedId));

    // Same cutoff applies to the registrations list and the payment
    // checkout-session route -- both re-check ownership via
    // getManagedPerson/isManagedBy, which now fail for the former owner.
    const registrationsRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/registrations`, { headers: { Cookie: cookie } });
    assert.equal(registrationsRes.status, 404);

    const checkoutRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${managedId}/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(checkoutRes.status, 403);
  } finally {
    server.close();
  }
});

test('POST /managed-persons/:id/convert without an email on file still returns a link (the e-mail is entered on redeeming)', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'NoEmailConvert' }),
    });
    const { id: managedId } = await personRes.json();

    const res = await fetch(`http://localhost:${port}/managed-persons/${managedId}/convert`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(res.status, 201);
    assert.ok((await res.json()).link);
  } finally {
    server.close();
  }
});

test('PUT /events/:eventId/registrations/:userId/ot-fields lets an owner edit their managed person\'s registration, 403s for a stranger', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'OtFields' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Managed OtFields Test Event', '2026-04-01', true) RETURNING id"
    );
    const eventId = eventRows[0].id;
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role) VALUES ($1, $2, 'helfer')",
      [managedId, eventId]
    );

    const ownerRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${managedId}/ot-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ conTage: '5' }),
    });
    assert.equal(ownerRes.status, 200);
    assert.equal((await ownerRes.json()).conTage, '5');

    const strangerRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${managedId}/ot-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ conTage: '9' }),
    });
    assert.equal(strangerRes.status, 403);
  } finally {
    server.close();
  }
});

test('a managed person needs only a nickname or a character name, and its invitation link works without an e-mail', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const post = (path, body, c = cookie) => fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c }, body: body === undefined ? undefined : JSON.stringify(body) });

    assert.equal((await post('/managed-persons', { email: '' })).status, 400);
    assert.equal((await post('/managed-persons', { firstName: 'OnlyFirst' })).status, 400);

    const created = await post('/managed-persons', { characterName: 'ManagedTestChar' });
    assert.equal(created.status, 201);
    const person = await created.json();
    assert.equal(person.nickname, 'ManagedTestChar');
    const { rows: chars } = await query('SELECT name, class FROM characters WHERE user_id = $1', [person.id]);
    assert.deepEqual(chars, [{ name: 'ManagedTestChar', class: 'sc' }]);

    const link = (await (await post(`/managed-persons/${person.id}/convert`)).json()).link;
    const token = new URL(link).searchParams.get('token');
    const info = await (await fetch(`http://localhost:${port}/auth/invite/info?token=${token}`)).json();
    assert.equal(info.needsEmail, true);

    const redeem = (body) => post('/auth/invite/redeem', { token, password: 'correct horse battery staple', ...body }, '');
    assert.equal((await redeem({})).status, 400);
    assert.equal((await redeem({ email: `managed-owner-${crypto.randomUUID()}@example.com` })).status, 200);
    const { rows } = await query('SELECT is_guest, managed_by_user_id, email FROM users WHERE id = $1', [person.id]);
    assert.equal(rows[0].is_guest, false);
    assert.equal(rows[0].managed_by_user_id, null);
    assert.ok(rows[0].email.startsWith('managed-owner-'));
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM registrations WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Managed Delete Test%' OR name LIKE 'Managed Convert Test%')");
  await query("DELETE FROM events WHERE name LIKE 'Managed Delete Test%' OR name LIKE 'Managed Convert Test%'");
  await query("DELETE FROM invitations WHERE email LIKE 'managed-convert-%' OR user_id IN (SELECT id FROM users WHERE nickname = 'ManagedTestChar' OR first_name = 'ManagedTestPerson') OR invited_by IN (SELECT id FROM users WHERE email LIKE 'managed-owner-%')");
  await query("DELETE FROM users WHERE email LIKE 'managed-owner-%' OR first_name = 'ManagedTestPerson' OR nickname = 'ManagedTestChar'");
  await closePool();
});
