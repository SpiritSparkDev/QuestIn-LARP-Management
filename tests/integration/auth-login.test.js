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
const { query, closePool } = await import('../../backend/db.js');
const { SESSION_COOKIE_NAME } = await import('../../backend/auth/cookies.js');

async function registerAndVerify(port, email, password) {
  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Login Test' }),
  });
  const { id } = await registerRes.json();
  const { rows } = await query('SELECT token FROM email_verification_tokens WHERE user_id = $1', [id]);
  await fetch(`http://localhost:${port}/auth/verify?token=${rows[0].token}`);
  return id;
}

test('login with correct credentials sets a session cookie', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `login-${crypto.randomUUID()}@example.com`;
  const password = 'correct horse battery staple';
  await registerAndVerify(port, email, password);

  const res = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`));

  server.close();
});

test('login with wrong password is rejected with 401', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `wrongpw-${crypto.randomUUID()}@example.com`;
  await registerAndVerify(port, email, 'correct horse battery staple');

  const res = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong password' }),
  });
  assert.equal(res.status, 401);

  server.close();
});

test('login before email verification is rejected with 403', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `unverified-${crypto.randomUUID()}@example.com`;
  const password = 'correct horse battery staple';

  await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Unverified' }),
  });

  const res = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 403);

  server.close();
});

test('logout clears the session so it can no longer be used', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `logout-${crypto.randomUUID()}@example.com`;
  const password = 'correct horse battery staple';
  await registerAndVerify(port, email, password);

  const loginRes = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  const token = cookie.split('=')[1];

  const logoutRes = await fetch(`http://localhost:${port}/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(logoutRes.status, 200);

  const { getSession } = await import('../../backend/auth/sessions.js');
  assert.equal(await getSession(token), null);

  server.close();
});

test.after(async () => {
  await closePool();
});
