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

const { seedNscProfileSchema } = await import('../../db/seedNscProfileSchema.js');
await seedNscProfileSchema();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createServer } = await import('../../backend/server.js');

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'NSC Schema Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`nsc-schema-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /nsc-schema rejects a group that is neither admin nor nsc', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/nsc-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('GET /nsc-schema is reachable by an nsc-group user and returns the seeded default fields', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('nsc');
    const res = await fetch(`http://localhost:${port}/nsc-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const schema = await res.json();
    assert.ok(schema.some((f) => f.key === 'fuerOrgaanfragenOffen'));
    assert.ok(schema.some((f) => f.key === 'rollenAusruestung' && f.type === 'multiselect'));
  } finally {
    server.close();
  }
});

test('PUT /nsc-schema rejects a non-admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('nsc');
    const res = await fetch(`http://localhost:${port}/nsc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [] }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('PUT /nsc-schema updates the schema for an admin caller', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const newSchema = [{ key: 'test', label: 'Test', type: 'text' }];
    try {
      const putRes = await fetch(`http://localhost:${port}/nsc-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: newSchema }),
      });
      assert.equal(putRes.status, 200);

      const getRes = await fetch(`http://localhost:${port}/nsc-schema`, { headers: { Cookie: cookie } });
      const schema = await getRes.json();
      assert.deepEqual(schema, newSchema);
    } finally {
      // Restore the real defaults so later tests/manual verification in this
      // shared DB aren't left with a one-field test schema, even if an
      // assertion above threw.
      const { NSC_PROFILE_SCHEMA_DEFAULTS } = await import('../../config/nscProfileDefaults.js');
      await fetch(`http://localhost:${port}/nsc-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: NSC_PROFILE_SCHEMA_DEFAULTS }),
      });
    }
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'nsc-schema-%'");
  await closePool();
});
