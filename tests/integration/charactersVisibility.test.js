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
    [`chars-vis-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

const VISIBILITY_SCHEMA = [
  { key: 'fraction', label: 'Fraktion', type: 'text', public: true },
  { key: 'secretNote', label: 'Geheimnis', type: 'text' },
];

async function makeEvent(schema = VISIBILITY_SCHEMA, isActive = true) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, character_form_schema, is_active)
     VALUES ('Visibility Test Con', '2027-06-01', $1, $2) RETURNING id`,
    [JSON.stringify(schema), isActive]
  );
  return rows[0].id;
}

// Creates an sc-class character, registers it for eventId, and writes `data`
// through PUT with eventId -- the character only shows up in
// /events/:eventId/characters/public once it's actually registered (the
// endpoint joins through registrations.character_id, not a direct column).
async function makeRegisteredCharacter(port, cookie, eventId, name, data) {
  const createRes = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name }),
  });
  const { id } = await createRes.json();

  await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ conRole: 'sc', characterId: id }),
  });

  await fetch(`http://localhost:${port}/characters/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ eventId, data }),
  });

  return id;
}

test('owner sees a non-public field; a different non-elevated user does not', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();

    const id = await makeRegisteredCharacter(port, owner.cookie, eventId, 'Aldric', { fraction: 'Nordmark', secretNote: 'Doppelagent' });

    const ownerView = await (await fetch(`http://localhost:${port}/events/${eventId}/characters/public`, {
      headers: { Cookie: owner.cookie },
    })).json();
    const ownerChar = ownerView.find((c) => c.id === id);
    assert.deepEqual(Object.keys(ownerChar.data).sort(), ['fraction', 'secretNote']);

    const strangerView = await (await fetch(`http://localhost:${port}/events/${eventId}/characters/public`, {
      headers: { Cookie: stranger.cookie },
    })).json();
    const strangerChar = strangerView.find((c) => c.id === id);
    assert.deepEqual(Object.keys(strangerChar.data).sort(), ['fraction']);
  });
});

test('a public field is visible to a different non-elevated user', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();

    const id = await makeRegisteredCharacter(port, owner.cookie, eventId, 'Bera', { fraction: 'Suedmark', secretNote: 'Verboten' });

    const strangerView = await (await fetch(`http://localhost:${port}/events/${eventId}/characters/public`, {
      headers: { Cookie: stranger.cookie },
    })).json();
    const strangerChar = strangerView.find((c) => c.id === id);
    assert.equal(strangerChar.data.fraction, 'Suedmark');
  });
});

test('an elevated-group user sees all fields of all characters for the event', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const admin = await makeUserAndSession('admin');
    const eventId = await makeEvent();

    const id = await makeRegisteredCharacter(port, owner.cookie, eventId, 'Corvin', { fraction: 'Ostmark', secretNote: 'Top Secret' });

    const adminView = await (await fetch(`http://localhost:${port}/events/${eventId}/characters/public`, {
      headers: { Cookie: admin.cookie },
    })).json();
    const adminChar = adminView.find((c) => c.id === id);
    assert.deepEqual(Object.keys(adminChar.data).sort(), ['fraction', 'secretNote']);
    assert.equal(adminChar.data.secretNote, 'Top Secret');
  });
});

test('GET /events/:eventId/characters/public for an unknown event returns 404', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const res = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/characters/public`, {
      headers: { Cookie: participant.cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('characters from multiple different users are each independently filtered per the viewer', async () => {
  await withTestServer(async (port) => {
    const alice = await makeUserAndSession();
    const bob = await makeUserAndSession();
    const viewer = await makeUserAndSession();
    const eventId = await makeEvent();

    const aliceId = await makeRegisteredCharacter(port, alice.cookie, eventId, 'Alice Char', { fraction: 'Nordmark', secretNote: 'Alice Secret' });
    const bobId = await makeRegisteredCharacter(port, bob.cookie, eventId, 'Bob Char', { fraction: 'Suedmark', secretNote: 'Bob Secret' });

    const viewerView = await (await fetch(`http://localhost:${port}/events/${eventId}/characters/public`, {
      headers: { Cookie: viewer.cookie },
    })).json();

    const aliceChar = viewerView.find((c) => c.id === aliceId);
    const bobChar = viewerView.find((c) => c.id === bobId);

    assert.deepEqual(Object.keys(aliceChar.data).sort(), ['fraction']);
    assert.equal(aliceChar.data.fraction, 'Nordmark');
    assert.equal(aliceChar.userId, alice.userId);

    assert.deepEqual(Object.keys(bobChar.data).sort(), ['fraction']);
    assert.equal(bobChar.data.fraction, 'Suedmark');
    assert.equal(bobChar.userId, bob.userId);

    const aliceOwnView = await (await fetch(`http://localhost:${port}/events/${eventId}/characters/public`, {
      headers: { Cookie: alice.cookie },
    })).json();
    const aliceCharForAlice = aliceOwnView.find((c) => c.id === aliceId);
    const bobCharForAlice = aliceOwnView.find((c) => c.id === bobId);
    assert.deepEqual(Object.keys(aliceCharForAlice.data).sort(), ['fraction', 'secretNote']);
    assert.deepEqual(Object.keys(bobCharForAlice.data).sort(), ['fraction']);
  });
});

test('GET /characters/:id filters non-public fields for a non-owner, non-elevated viewer', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();

    const id = await makeRegisteredCharacter(port, owner.cookie, eventId, 'Delwyn', { fraction: 'Westmark', secretNote: 'Verraeter' });

    const strangerGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(strangerGet.status, 200);
    const strangerBody = await strangerGet.json();
    // GET /characters/:id (not the per-event /public list) has no single
    // event context to resolve a schema against anymore -- a stranger only
    // ever sees the name, regardless of any field's `public` flag.
    assert.deepEqual(strangerBody.data, {});

    const missingGet = await fetch(`http://localhost:${port}/characters/${crypto.randomUUID()}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(missingGet.status, 404);
  });
});

test.after(async () => {
  await closePool();
});
