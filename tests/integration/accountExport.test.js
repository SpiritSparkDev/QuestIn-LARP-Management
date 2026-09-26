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

async function makeUserAndSession() {
  const email = `export-test-${crypto.randomUUID()}@example.com`;
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Export', 'Tester', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [email]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, email, cookie: `session=${session.token}` };
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active) VALUES ('Export Test Con', '2027-10-01', true) RETURNING id"
  );
  return rows[0].id;
}

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('GET /account/export requires authentication', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/account/export`);
    assert.equal(res.status, 401);
  });
});

test('GET /account/export returns a text file containing the caller\'s own account, character, registration, and payment data', async () => {
  await withTestServer(async (port) => {
    const { userId, email, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ class: 'sc', name: 'Exportia', data: {} }),
    });
    const character = await charRes.json();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: character.id }),
    });

    await query(
      "INSERT INTO payments (user_id, event_id, method, amount_cents) VALUES ($1, $2, 'bank_transfer', 1500)",
      [userId, eventId]
    );

    const res = await fetch(`http://localhost:${port}/account/export`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="pakyrion-daten-.*\.txt"/);

    const text = await res.text();
    assert.match(text, new RegExp(email));
    assert.match(text, /Exportia/);
    assert.match(text, /Export Test Con/);
    assert.match(text, /15,00 €/);
    assert.doesNotMatch(text, /15\.00/);
  });
});

test('GET /account/export/files returns 404 when the caller has no uploaded files', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const res = await fetch(`http://localhost:${port}/account/export/files`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404);
  });
});

test('GET /account/export/files returns a real ZIP archive when the caller has uploaded files', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Zip Test Char', data: {} }),
    });
    const character = await charRes.json();
    await fetch(`http://localhost:${port}/characters/${character.id}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ kind: 'image', filename: 'portrait.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, isPublic: false, gdprConsent: true }),
    });

    const res = await fetch(`http://localhost:${port}/account/export/files`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const bytes = Buffer.from(await res.arrayBuffer());
    // "PK\x03\x04" is the ZIP local-file-header signature -- confirms a
    // real archive was produced without needing a ZIP-reading library.
    assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});

test('GET /account/export/files only bundles the caller\'s own characters\' files, never another user\'s', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const other = await makeUserAndSession();
    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Owner Only Char', data: {} }),
    });
    const character = await charRes.json();
    await fetch(`http://localhost:${port}/characters/${character.id}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'image', filename: 'portrait.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, isPublic: false, gdprConsent: true }),
    });

    const res = await fetch(`http://localhost:${port}/account/export/files`, { headers: { Cookie: other.cookie } });
    assert.equal(res.status, 404);
  });
});

test.after(async () => {
  // character_files.uploaded_by -> users has no cascade action (unlike
  // character_files.character_id -> characters, which does), so deleting a
  // user directly can still hit that FK even after their characters/files
  // are gone via the other path. Explicit order avoids both RESTRICTs:
  // registrations (references character_id) -> characters (cascades their
  // own files away) -> users.
  await query(`DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'export-test-%')`);
  await query(`DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'export-test-%')`);
  await query("DELETE FROM users WHERE email LIKE 'export-test-%'");
  await query("DELETE FROM events WHERE name = 'Export Test Con'");
  await closePool();
});
