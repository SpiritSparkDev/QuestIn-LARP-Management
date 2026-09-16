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

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Sc', 'Schema Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`sc-schema-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /sc-schema is reachable by any authenticated user and starts empty on a fresh DB', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/sc-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test('GET /sc-schema requires authentication', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/sc-schema`);
    assert.equal(res.status, 401);
  });
});

test('PUT /sc-schema rejects a non-admin group', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/sc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [] }),
    });
    assert.equal(res.status, 403);
  });
});

test('PUT /sc-schema updates the schema for an admin caller', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const newSchema = [{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }];
    const putRes = await fetch(`http://localhost:${port}/sc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: newSchema }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`http://localhost:${port}/sc-schema`, { headers: { Cookie: cookie } });
    assert.deepEqual(await getRes.json(), newSchema);
  });
});

test('PUT /sc-schema rejects a schema using the reserved key "id" or duplicate keys', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');

    const withId = await fetch(`http://localhost:${port}/sc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [{ key: 'id', label: 'Id', type: 'text' }] }),
    });
    assert.equal(withId.status, 400);

    const withDuplicate = await fetch(`http://localhost:${port}/sc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [
        { key: 'x', label: 'X', type: 'text' },
        { key: 'x', label: 'X (2)', type: 'text' },
      ] }),
    });
    assert.equal(withDuplicate.status, 400);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'sc-schema-%'");
  await closePool();
});
