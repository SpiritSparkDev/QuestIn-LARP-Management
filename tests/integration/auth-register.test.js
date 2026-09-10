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
const { query, closePool } = await import('../../backend/db.js');
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');

test.beforeEach(resetRateLimits);

test('register creates an unverified user with a verification token; verify activates it', async () => {
  await withTestServer(async (port) => {
    const email = `test-${crypto.randomUUID()}@example.com`;

    const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct horse battery staple', firstName: 'Test', lastName: 'User' }),
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
  });
});

test('POST /auth/register accepts the exact field shape frontend/register.html sends', async () => {
  await withTestServer(async (port) => {
    const email = `register-html-shape-${crypto.randomUUID()}@example.com`;
    const res = await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Test', lastName: 'User', email, password: 'correct horse battery staple' }),
    });
    assert.equal(res.status, 201);
  });
});

test('registering with a password shorter than 8 characters is rejected with 400', async () => {
  await withTestServer(async (port) => {
    const email = `shortpw-${crypto.randomUUID()}@example.com`;

    const res = await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'abc', firstName: 'Short', lastName: 'Password' }),
    });
    assert.equal(res.status, 400);
  });
});

test('registering with a malformed email is rejected with 400', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'correct horse battery staple', firstName: 'Bad', lastName: 'Email' }),
    });
    assert.equal(res.status, 400);
  });
});

test('registering the same email twice is rejected with 409', async () => {
  await withTestServer(async (port) => {
    const email = `dup-${crypto.randomUUID()}@example.com`;
    const payload = { email, password: 'correct horse battery staple', firstName: 'Dup', lastName: 'User' };

    await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const secondRes = await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(secondRes.status, 409);
  });
});

test('concurrent registrations for the same email: one 201, one 409, no 500', async () => {
  await withTestServer(async (port) => {
    const email = `race-${crypto.randomUUID()}@example.com`;
    const payload = { email, password: 'correct horse battery staple', firstName: 'Race', lastName: 'User' };

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
  });
});

test('resending verification issues a new token and invalidates the old one', async () => {
  await withTestServer(async (port) => {
    const email = `resend-${crypto.randomUUID()}@example.com`;

    const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct horse battery staple', firstName: 'Resend', lastName: 'User' }),
    });
    const { id } = await registerRes.json();
    const { rows: oldTokenRows } = await query(
      'SELECT token FROM email_verification_tokens WHERE user_id = $1', [id]
    );
    const oldToken = oldTokenRows[0].token;

    const resendRes = await fetch(`http://localhost:${port}/auth/verify/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(resendRes.status, 200);

    const { rows: newTokenRows } = await query(
      'SELECT token FROM email_verification_tokens WHERE user_id = $1', [id]
    );
    assert.equal(newTokenRows.length, 1);
    const newToken = newTokenRows[0].token;
    assert.notEqual(newToken, oldToken);

    const { rows: oldTokenAfter } = await query(
      'SELECT token FROM email_verification_tokens WHERE token = $1', [oldToken]
    );
    assert.equal(oldTokenAfter.length, 0);

    const verifyRes = await fetch(`http://localhost:${port}/auth/verify?token=${newToken}`);
    assert.equal(verifyRes.status, 200);
  });
});

test('resending verification for an unknown or already-verified email still returns 200', async () => {
  await withTestServer(async (port) => {
    const unknownRes = await fetch(`http://localhost:${port}/auth/verify/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@example.com` }),
    });
    assert.equal(unknownRes.status, 200);

    const email = `already-verified-${crypto.randomUUID()}@example.com`;
    const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct horse battery staple', firstName: 'Verified', lastName: 'User' }),
    });
    const { id } = await registerRes.json();
    const { rows: tokenRows } = await query('SELECT token FROM email_verification_tokens WHERE user_id = $1', [id]);
    await fetch(`http://localhost:${port}/auth/verify?token=${tokenRows[0].token}`);

    const verifiedRes = await fetch(`http://localhost:${port}/auth/verify/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(verifiedRes.status, 200);
  });
});

test('verify with an unknown token returns 400', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/verify?token=does-not-exist`);
    assert.equal(res.status, 400);
  });
});

test('POST /auth/register is rate-limited per IP after 10 attempts in the window', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await fetch(`http://localhost:${port}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `ratelimit-${i}-${crypto.randomUUID()}@example.com`, password: 'correct horse battery staple', firstName: 'Rate', lastName: 'Limit Test' }),
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

test('POST /auth/verify/resend is rate-limited per IP after 10 attempts in the window', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await fetch(`http://localhost:${port}/auth/verify/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `nobody-${i}@example.com` }),
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
