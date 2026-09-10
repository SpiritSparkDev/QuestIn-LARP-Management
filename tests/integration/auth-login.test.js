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
const { query, closePool } = await import('../../backend/db.js');
const { SESSION_COOKIE_NAME } = await import('../../backend/auth/cookies.js');
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');

test.beforeEach(resetRateLimits);

async function registerAndVerify(port, email, password) {
  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, firstName: 'Login', lastName: 'Test' }),
  });
  const { id } = await registerRes.json();
  const { rows } = await query('SELECT token FROM email_verification_tokens WHERE user_id = $1', [id]);
  await fetch(`http://localhost:${port}/auth/verify?token=${rows[0].token}`);
  return id;
}

test('login with correct credentials sets a session cookie', async () => {
  await withTestServer(async (port) => {
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
  });
});

test('login succeeds with a different email casing than used at registration', async () => {
  await withTestServer(async (port) => {
    const localPart = `case-${crypto.randomUUID()}`;
    const registerEmail = `${localPart}@Example.com`;
    const password = 'correct horse battery staple';
    await registerAndVerify(port, registerEmail, password);

    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${localPart}@EXAMPLE.COM`, password }),
    });
    assert.equal(res.status, 200);
  });
});

test('login with wrong password is rejected with 401', async () => {
  await withTestServer(async (port) => {
    const email = `wrongpw-${crypto.randomUUID()}@example.com`;
    await registerAndVerify(port, email, 'correct horse battery staple');

    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong password' }),
    });
    assert.equal(res.status, 401);
  });
});

test('login before email verification is rejected with 403', async () => {
  await withTestServer(async (port) => {
    const email = `unverified-${crypto.randomUUID()}@example.com`;
    const password = 'correct horse battery staple';

    await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, firstName: 'Unverified', lastName: 'User' }),
    });

    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 403);
  });
});

test('POST /auth/login rejects a correct password for a deactivated account', async () => {
  await withTestServer(async (port) => {
    const email = `login-deactivated-${crypto.randomUUID()}@example.com`;
    const password = 'correct horse battery staple';
    await registerAndVerify(port, email, password);
    await query('UPDATE users SET deactivated_at = now() WHERE email = $1', [email]);

    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /deaktiviert/);
  });
});

test('logout clears the session so it can no longer be used', async () => {
  await withTestServer(async (port) => {
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
  });
});

// The rate limiter's `buckets` Map is module-level state shared across every
// test in this file, and every login attempt counts toward BOTH the IP bucket
// and the email bucket. The other 6 login-calling tests in this file all hit
// `http://localhost:...`, which resolves to `::1` here — sharing one IP bucket
// (`login-ip:::1`) among themselves regardless of ordering: 5 pre-existing
// calls + this test's own 5 pre-trip calls already equal the IP limit (10), so
// its trip call would be swallowed by the IP check first no matter where in
// the file it runs. Hitting `127.0.0.1` explicitly instead (a distinct
// `remoteAddress` string, `::ffff:127.0.0.1`) puts this test in its own IP
// bucket, fully isolated from the other tests' shared budget — so its 429 is
// unambiguously the email-dimension check tripping, not IP interference.
test('POST /auth/login is rate-limited per email after 5 attempts in the window, even from conceptually different requests', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const email = `ratelimit-email-${crypto.randomUUID()}@example.com`;
    let lastRes;
    for (let i = 0; i < 6; i++) {
      lastRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong password' }),
      });
    }
    assert.equal(lastRes.status, 429);
    const body = await lastRes.json();
    assert.equal(body.error, 'Zu viele Versuche. Bitte später erneut versuchen.');
  } finally {
    server.close();
  }
});

// Uses `localhost` (-> `::1` here), the same address as the file's other
// login-calling tests, so this test's shared IP bucket already carries their
// attempts too — don't assume a clean bucket or an exact trip count, just loop
// enough (11) to guarantee it trips regardless of how many prior calls landed
// in this bucket, and check the last response.
test('POST /auth/login is rate-limited per IP after 10 attempts in the window, even across different emails', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await fetch(`http://localhost:${port}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `nobody-${i}@example.com`, password: 'wrong password' }),
      });
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
