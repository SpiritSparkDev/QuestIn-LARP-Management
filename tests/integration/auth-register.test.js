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
const { query, closePool } = await import('../../backend/db.js');

test('register creates an unverified user with a verification token; verify activates it', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `test-${crypto.randomUUID()}@example.com`;

  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'Test User' }),
  });
  assert.equal(registerRes.status, 201);
  const registerBody = await registerRes.json();
  assert.equal(registerBody.email, email);

  const { rows: userRows } = await query('SELECT email_verified FROM users WHERE id = $1', [registerBody.id]);
  assert.equal(userRows[0].email_verified, false);

  const { rows: tokenRows } = await query(
    'SELECT token FROM email_verification_tokens WHERE user_id = $1',
    [registerBody.id]
  );
  assert.equal(tokenRows.length, 1);

  const verifyRes = await fetch(`http://localhost:${port}/auth/verify?token=${tokenRows[0].token}`);
  assert.equal(verifyRes.status, 200);

  const { rows: verifiedRows } = await query('SELECT email_verified FROM users WHERE id = $1', [registerBody.id]);
  assert.equal(verifiedRows[0].email_verified, true);

  const { rows: tokenAfter } = await query(
    'SELECT token FROM email_verification_tokens WHERE token = $1',
    [tokenRows[0].token]
  );
  assert.equal(tokenAfter.length, 0);

  server.close();
});

test('registering the same email twice is rejected with 409', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `dup-${crypto.randomUUID()}@example.com`;
  const payload = { email, password: 'correct horse battery staple', name: 'Dup User' };

  await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const secondRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(secondRes.status, 409);

  server.close();
});

test('concurrent registrations for the same email: one 201, one 409, no 500', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const email = `race-${crypto.randomUUID()}@example.com`;
  const payload = { email, password: 'correct horse battery staple', name: 'Race User' };

  const [firstRes, secondRes] = await Promise.all([
    fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
    fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
  ]);
  const statuses = [firstRes.status, secondRes.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  server.close();
});

test('verify with an unknown token returns 400', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/auth/verify?token=does-not-exist`);
  assert.equal(res.status, 400);
  server.close();
});

test.after(async () => {
  await closePool();
});
