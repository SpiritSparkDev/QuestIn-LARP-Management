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

test.after(async () => {
  await closePool();
});
