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
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Reg', 'Schema Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`reg-schema-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /registration-schema defaults to the 6 built-in registration fields', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/registration-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const schema = await res.json();
    assert.deepEqual(schema.map((f) => f.key).sort(), [
      'accommodation', 'conTage', 'craftOffer', 'dataSharingOptOut', 'photoOptOut', 'travelMethod',
    ].sort());
    assert.equal(schema.find((f) => f.key === 'dataSharingOptOut').type, 'boolean');
  });
});

test('PUT /registration-schema rejects a non-admin group and the reserved "id" key for an admin', async () => {
  await withTestServer(async (port) => {
    const { cookie: memberCookie } = await makeUserAndSession('mitglied');
    const forbidden = await fetch(`http://localhost:${port}/registration-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ schema: [] }),
    });
    assert.equal(forbidden.status, 403);

    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const rejected = await fetch(`http://localhost:${port}/registration-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ schema: [{ key: 'id', label: 'Id', type: 'text' }] }),
    });
    assert.equal(rejected.status, 400);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'reg-schema-%'");
  await closePool();
});
