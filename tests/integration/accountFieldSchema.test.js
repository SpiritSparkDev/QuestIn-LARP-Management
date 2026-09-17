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
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Account', 'Schema Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`account-schema-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /account-schema is reachable by any authenticated user and defaults to the 7 built-in account fields', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/account-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const schema = await res.json();
    assert.deepEqual(schema.map((f) => f.key).sort(), [
      'address', 'birthdate', 'emergencyContactFirstName', 'emergencyContactLastName',
      'emergencyContactPhone', 'medicalNotes', 'phone',
    ].sort());
    assert.equal(schema.find((f) => f.key === 'birthdate').type, 'date');
  });
});

test('GET /account-schema requires authentication', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/account-schema`);
    assert.equal(res.status, 401);
  });
});

test('PUT /account-schema rejects a non-admin group', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/account-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [] }),
    });
    assert.equal(res.status, 403);
  });
});

test('PUT /account-schema updates the schema for an admin caller and rejects the reserved "group" key', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const originalRes = await fetch(`http://localhost:${port}/account-schema`, { headers: { Cookie: cookie } });
    const original = await originalRes.json();
    const newSchema = [{ key: 'shirtSize', label: 'Shirtgröße', type: 'text', required: false }];
    try {
      const putRes = await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: newSchema }),
      });
      assert.equal(putRes.status, 200);
      const getRes = await fetch(`http://localhost:${port}/account-schema`, { headers: { Cookie: cookie } });
      assert.deepEqual(await getRes.json(), newSchema);

      const rejected = await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: [{ key: 'group', label: 'Gruppe', type: 'text' }] }),
      });
      assert.equal(rejected.status, 400);

      const rejectedEmail = await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: [{ key: 'email', label: 'E-Mail', type: 'text' }] }),
      });
      assert.equal(rejectedEmail.status, 400);
    } finally {
      await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: original }),
      });
    }
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'account-schema-%'");
  await closePool();
});
