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

const { createServer } = await import('../../backend/server.js');
await import('../../backend/auth/register.js');
await import('../../backend/auth/login.js');
await import('../../backend/auth/passwordReset.js');
await import('../../backend/accounts/routes.js');
const { query, closePool } = await import('../../backend/db.js');
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');

test.beforeEach(resetRateLimits);

async function registerAndVerify(port, email, password) {
  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, firstName: 'Reset', lastName: 'Test' }),
  });
  const { id } = await registerRes.json();
  const { rows } = await query('SELECT access_token AS token FROM users WHERE id = $1', [id]);
  await fetch(`http://localhost:${port}/auth/verify?token=${rows[0].token}`);
  return id;
}

test('requesting a reset for an existing email resends their existing permanent access link; confirming changes the password', async () => {
  await withTestServer(async (port) => {
    const email = `reset-${crypto.randomUUID()}@example.com`;
    const oldPassword = 'correct horse battery staple';
    const newPassword = 'a totally different passphrase';
    const userId = await registerAndVerify(port, email, oldPassword);
    const { rows: beforeRows } = await query('SELECT access_token FROM users WHERE id = $1', [userId]);
    const tokenBeforeRequest = beforeRows[0].access_token;

    const requestRes = await fetch(`http://localhost:${port}/auth/password-reset/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(requestRes.status, 200);

    // Requesting a reset only resends the existing link -- it doesn't rotate
    // the token. Rotation happens once the link is actually used below.
    const { rows } = await query('SELECT access_token AS token FROM users WHERE id = $1', [userId]);
    assert.equal(rows[0].token, tokenBeforeRequest);

    const confirmRes = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rows[0].token, password: newPassword }),
    });
    assert.equal(confirmRes.status, 200);

    const { rows: afterRows } = await query('SELECT access_token FROM users WHERE id = $1', [userId]);
    assert.notEqual(afterRows[0].access_token, tokenBeforeRequest);

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
  });
});

test('confirming a reset invalidates existing sessions', async () => {
  await withTestServer(async (port) => {
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
    const { rows } = await query('SELECT access_token AS token FROM users WHERE email = $1', [email]);

    const confirmRes = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rows[0].token, password: newPassword }),
    });
    assert.equal(confirmRes.status, 200);

    const postResetAccountRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: oldCookie } });
    assert.equal(postResetAccountRes.status, 401);
  });
});

test('requesting a reset for an unknown email still returns 200 (no email enumeration)', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/password-reset/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@example.com` }),
    });
    assert.equal(res.status, 200);
  });
});

test('a used access link is dead, but the freshly rotated one still resets the password', async () => {
  await withTestServer(async (port) => {
    const email = `reset-rotate-${crypto.randomUUID()}@example.com`;
    const userId = await registerAndVerify(port, email, 'correct horse battery staple');
    const { rows: beforeRows } = await query('SELECT access_token FROM users WHERE id = $1', [userId]);
    const usedToken = beforeRows[0].access_token;

    const firstConfirm = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: usedToken, password: 'a totally different passphrase' }),
    });
    assert.equal(firstConfirm.status, 200);

    const replayConfirm = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: usedToken, password: 'yet another passphrase' }),
    });
    assert.equal(replayConfirm.status, 400);

    const { rows: afterRows } = await query('SELECT access_token FROM users WHERE id = $1', [userId]);
    const newToken = afterRows[0].access_token;
    assert.notEqual(newToken, usedToken);

    const secondConfirm = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: newToken, password: 'yet another passphrase' }),
    });
    assert.equal(secondConfirm.status, 200);
  });
});

test('confirming with an invalid token returns 400', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'does-not-exist', password: 'whatever' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /auth/password-reset/request is rate-limited per IP after 10 attempts in the window', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await fetch(`http://localhost:${port}/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      });
      if (i < 10) {
        assert.notEqual(lastRes.status, 429, `attempt ${i + 1} should not be rate-limited`);
      }
    }
    assert.equal(lastRes.status, 429);
    const body = await lastRes.json();
    assert.equal(body.error, 'Zu viele Anfragen. Bitte später erneut versuchen.');
  } finally {
    server.close();
  }
});

test.after(async () => {
  await closePool();
});
