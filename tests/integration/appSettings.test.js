import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Branding', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`app-settings-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return `session=${session.token}`;
}

test('GET /app-settings requires no authentication and returns nulls when unset', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100 });
  });
});

test('PUT /app-settings saves and GET reflects it back, then update overwrites', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const putRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ logoUrl: 'https://example.com/logo.png', appTitle: 'P17 Check-In', eventName: 'P17/2027' }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.appTitle, 'P17 Check-In');

    const getRes = await fetch(`http://localhost:${port}/app-settings`);
    const getBody = await getRes.json();
    assert.deepEqual(getBody, { logoUrl: 'https://example.com/logo.png', appTitle: 'P17 Check-In', eventName: 'P17/2027', quotaMbPerCharacter: 100 });

    // Second PUT overwrites the same row rather than inserting a new one.
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ logoUrl: null, appTitle: 'Renamed', eventName: 'P17/2027' }),
    });
    const { rows } = await query('SELECT count(*)::int FROM app_settings');
    assert.equal(rows[0].count, 1);
  });
});

test('PUT /app-settings rejects a non-admin group and an unauthenticated request', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('sc');
    const asMember = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appTitle: 'Hijacked' }),
    });
    assert.equal(asMember.status, 403);

    const anonymous = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appTitle: 'Hijacked' }),
    });
    assert.equal(anonymous.status, 401);
  });
});

test('PUT /app-settings validates and saves quotaMbPerCharacter; defaults to 100', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal((await res.json()).quotaMbPerCharacter, 100);

    const cookie = await makeUserAndSession('admin');
    const badRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ quotaMbPerCharacter: -5 }),
    });
    assert.equal(badRes.status, 400);

    const goodRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ quotaMbPerCharacter: 250 }),
    });
    assert.equal(goodRes.status, 200);
    assert.equal((await goodRes.json()).quotaMbPerCharacter, 250);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'app-settings-%'");
  await query('DELETE FROM app_settings');
  await closePool();
});
