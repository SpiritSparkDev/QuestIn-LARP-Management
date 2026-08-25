import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { createServer } = await import('../../backend/server.js');
await import('../../backend/auth/register.js');
await import('../../backend/auth/login.js');
await import('../../backend/auth/passwordReset.js');
await import('../../backend/accounts/routes.js');
const { query, closePool } = await import('../../backend/db.js');

async function registerAndVerify(port, email, password) {
  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Reset Test' }),
  });
  const { id } = await registerRes.json();
  const { rows } = await query('SELECT token FROM email_verification_tokens WHERE user_id = $1', [id]);
  await fetch(`http://localhost:${port}/auth/verify?token=${rows[0].token}`);
  return id;
}

test('requesting a reset for an existing email creates a token; confirming changes the password', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `reset-${crypto.randomUUID()}@example.com`;
  const oldPassword = 'correct horse battery staple';
  const newPassword = 'a totally different passphrase';
  const userId = await registerAndVerify(port, email, oldPassword);

  const requestRes = await fetch(`http://localhost:${port}/auth/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(requestRes.status, 200);

  const { rows } = await query('SELECT token FROM password_reset_tokens WHERE user_id = $1', [userId]);
  assert.equal(rows.length, 1);

  const confirmRes = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rows[0].token, password: newPassword }),
  });
  assert.equal(confirmRes.status, 200);

  const oldLoginRes = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: oldPassword }),
  });
  assert.equal(oldLoginRes.status, 401);

  const newLoginRes = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: newPassword }),
  });
  assert.equal(newLoginRes.status, 200);

  server.close();
});

test('confirming a reset invalidates existing sessions', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `reset-session-${crypto.randomUUID()}@example.com`;
  const oldPassword = 'correct horse battery staple';
  const newPassword = 'a totally different passphrase';
  await registerAndVerify(port, email, oldPassword);

  const loginRes = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: oldPassword }),
  });
  const oldCookie = loginRes.headers.get('set-cookie').split(';')[0];

  const preResetAccountRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: oldCookie } });
  assert.equal(preResetAccountRes.status, 200);

  const requestRes = await fetch(`http://localhost:${port}/auth/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(requestRes.status, 200);
  const { rows } = await query('SELECT token FROM password_reset_tokens WHERE user_id = (SELECT id FROM users WHERE email = $1)', [email]);

  const confirmRes = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rows[0].token, password: newPassword }),
  });
  assert.equal(confirmRes.status, 200);

  const postResetAccountRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: oldCookie } });
  assert.equal(postResetAccountRes.status, 401);

  server.close();
});

test('requesting a reset for an unknown email still returns 200 (no email enumeration)', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/auth/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@example.com` }),
  });
  assert.equal(res.status, 200);
  server.close();
});

test('confirming with an invalid token returns 400', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'does-not-exist', password: 'whatever' }),
  });
  assert.equal(res.status, 400);
  server.close();
});

test.after(async () => {
  await closePool();
});
