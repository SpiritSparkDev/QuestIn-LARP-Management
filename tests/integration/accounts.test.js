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

const { createServer } = await import('../../backend/server.js');
await import('../../backend/auth/register.js');
await import('../../backend/auth/login.js');
await import('../../backend/accounts/routes.js');
const { query, closePool } = await import('../../backend/db.js');

async function registerLoginAndGetCookie(port) {
  const email = `account-${crypto.randomUUID()}@example.com`;
  const password = 'correct horse battery staple';

  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Account Test' }),
  });
  const { id } = await registerRes.json();
  const { rows } = await query('SELECT token FROM email_verification_tokens WHERE user_id = $1', [id]);
  await fetch(`http://localhost:${port}/auth/verify?token=${rows[0].token}`);

  const loginRes = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { userId: id, cookie: loginRes.headers.get('set-cookie').split(';')[0] };
}

async function makeUserAndSession(groupKey) {
  const { createSession } = await import('../../backend/auth/sessions.js');
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Account Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`account-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /account requires authentication', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/account`);
  assert.equal(res.status, 401);
  server.close();
});

test('GET /account returns the logged-in user\'s account with null sensitive fields initially', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { cookie } = await registerLoginAndGetCookie(port);

  const res = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'Account Test');
  assert.equal(body.address, null);
  assert.deepEqual(body.group, { key: 'sc', name: 'SC' });
  assert.ok(Array.isArray(body.menus));
  assert.equal(body.canEditCharacters, false);

  server.close();
});

test('PATCH /account encrypts and returns sensitive fields; unspecified fields survive a partial update', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { userId, cookie } = await registerLoginAndGetCookie(port);

  const patchRes = await fetch(`http://localhost:${port}/account`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ address: 'Musterstraße 1, 12345 Musterstadt', phone: '+49 123 456789', pronomen: 'sie/ihr' }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.address, 'Musterstraße 1, 12345 Musterstadt');
  assert.equal(patched.phone, '+49 123 456789');
  assert.equal(patched.pronomen, 'sie/ihr');
  assert.equal(patched.name, 'Account Test');

  const { rows } = await query('SELECT address_enc, pronomen_enc FROM users WHERE id = $1', [userId]);
  assert.notEqual(rows[0].address_enc.toString('utf8'), 'Musterstraße 1, 12345 Musterstadt');
  assert.notEqual(rows[0].pronomen_enc.toString('utf8'), 'sie/ihr');

  const secondPatchRes = await fetch(`http://localhost:${port}/account`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ medicalNotes: 'keine' }),
  });
  const secondPatched = await secondPatchRes.json();
  assert.equal(secondPatched.address, 'Musterstraße 1, 12345 Musterstadt');
  assert.equal(secondPatched.medicalNotes, 'keine');

  server.close();
});

test('PATCH /account validates nscData against the current nsc_profile_schema', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('nsc');
    const res = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ nscData: { notARealField: 'x' } }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /account accepts and round-trips valid nscData', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('nsc');
    const res = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ nscData: { fuerOrgaanfragenOffen: true, darstellungsstaerken: 'Wachen, Händler' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.nscData.fuerOrgaanfragenOffen, true);
    assert.equal(body.nscData.darstellungsstaerken, 'Wachen, Händler');
  } finally {
    server.close();
  }
});

test('PATCH /account rejects nscData from a non-nsc group user', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await registerLoginAndGetCookie(port); // default group: sc
    const res = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ nscData: { fuerOrgaanfragenOffen: true } }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'forbidden');
  } finally {
    server.close();
  }
});

test.after(async () => {
  await closePool();
});
