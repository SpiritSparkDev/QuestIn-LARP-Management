import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.OAUTH_REDIRECT_BASE_URL = 'http://localhost:3000';
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { createServer } = await import('../../backend/server.js');
const { findOrCreateOAuthUser } = await import('../../backend/auth/oauth.js');
const { PROVIDERS } = await import('../../backend/auth/oauthProviders.js');
const { query, closePool } = await import('../../backend/db.js');

test('GET /auth/oauth/google/start redirects to Google with a state cookie', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/auth/oauth/google/start`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(location.searchParams.get('client_id'), 'test-google-client-id');
  assert.ok(location.searchParams.get('state'));
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie.includes('oauth_state_google='));
  server.close();
});

test('GET /auth/oauth/unknown/start returns 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/auth/oauth/unknown/start`, { redirect: 'manual' });
  assert.equal(res.status, 404);
  server.close();
});

test('callback rejects a missing or mismatched state', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(
    `http://localhost:${port}/auth/oauth/google/callback?code=abc&state=does-not-match`,
    { headers: { Cookie: 'oauth_state_google=something-else' } }
  );
  assert.equal(res.status, 400);
  server.close();
});

test('callback with access_denied redirects to login instead of erroring', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();

  const startRes = await fetch(`http://localhost:${port}/auth/oauth/google/start`, { redirect: 'manual' });
  const state = new URL(startRes.headers.get('location')).searchParams.get('state');
  const stateCookie = startRes.headers.get('set-cookie').split(';')[0];

  const res = await fetch(
    `http://localhost:${port}/auth/oauth/google/callback?error=access_denied&state=${state}`,
    { headers: { Cookie: stateCookie }, redirect: 'manual' }
  );
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').startsWith('/login.html'));
  server.close();
});

test('findOrCreateOAuthUser creates a new verified, password-less user on first login', async () => {
  const email = `oauth-new-${crypto.randomUUID()}@example.com`;
  const userId = await findOrCreateOAuthUser('google', `google-${crypto.randomUUID()}`, email, 'OAuth Test', true);
  const { rows } = await query('SELECT email_verified, password_hash, name FROM users WHERE id = $1', [userId]);
  assert.equal(rows[0].email_verified, true);
  assert.equal(rows[0].password_hash, null);
  assert.equal(rows[0].name, 'OAuth Test');
});

test('findOrCreateOAuthUser returns the same user for a repeat login (no duplicate oauth_accounts row)', async () => {
  const email = `oauth-repeat-${crypto.randomUUID()}@example.com`;
  const providerUserId = `google-${crypto.randomUUID()}`;
  const first = await findOrCreateOAuthUser('google', providerUserId, email, 'Repeat');
  const second = await findOrCreateOAuthUser('google', providerUserId, email, 'Repeat');
  assert.equal(first, second);
  const { rows } = await query(
    'SELECT count(*)::int AS count FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2',
    ['google', providerUserId]
  );
  assert.equal(rows[0].count, 1);
});

test('findOrCreateOAuthUser links to an existing password-registered account by email', async () => {
  const email = `oauth-link-${crypto.randomUUID()}@example.com`;
  const { rows: existing } = await query(
    "INSERT INTO users (email, password_hash, group_id, name, email_verified) VALUES ($1, 'irrelevant-hash', (SELECT id FROM groups WHERE key = 'sc'), 'Existing User', true) RETURNING id",
    [email]
  );
  const userId = await findOrCreateOAuthUser('discord', `discord-${crypto.randomUUID()}`, email, 'Discord Name', true);
  assert.equal(userId, existing[0].id);
});

test('findOrCreateOAuthUser rejects linking when provider does not verify the email', async () => {
  const email = `oauth-unverified-${crypto.randomUUID()}@example.com`;
  const { rows: existing } = await query(
    "INSERT INTO users (email, password_hash, group_id, name, email_verified) VALUES ($1, 'irrelevant-hash', (SELECT id FROM groups WHERE key = 'sc'), 'Existing User', true) RETURNING id",
    [email]
  );
  await assert.rejects(
    () => findOrCreateOAuthUser('facebook', `facebook-${crypto.randomUUID()}`, email, 'Faker', false),
    (err) => err.code === 'OAUTH_EMAIL_NOT_VERIFIED'
  );
  const { rows: oauthRows } = await query(
    'SELECT count(*)::int AS count FROM oauth_accounts WHERE user_id = $1',
    [existing[0].id]
  );
  assert.equal(oauthRows[0].count, 0);
});

test('callback with mocked provider responses creates a session and redirects', async (t) => {
  const server = createServer().listen(0);
  const { port } = server.address();

  const startRes = await fetch(`http://localhost:${port}/auth/oauth/google/start`, { redirect: 'manual' });
  const state = new URL(startRes.headers.get('location')).searchParams.get('state');
  const stateCookie = startRes.headers.get('set-cookie').split(';')[0];

  const providerEmail = `oauth-callback-${crypto.randomUUID()}@example.com`;
  let capturedTokenRequestBody;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const href = String(url);
    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      capturedTokenRequestBody = options.body;
      return new Response(JSON.stringify({ access_token: 'fake-access-token' }), { status: 200 });
    }
    if (href.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
      return new Response(
        JSON.stringify({
          sub: `google-${crypto.randomUUID()}`,
          email: providerEmail,
          name: 'Callback User',
          email_verified: true,
        }),
        { status: 200 }
      );
    }
    return originalFetch(url, options);
  });

  const callbackRes = await fetch(
    `http://localhost:${port}/auth/oauth/google/callback?code=fake-code&state=${state}`,
    { headers: { Cookie: stateCookie }, redirect: 'manual' }
  );
  assert.equal(callbackRes.status, 302);
  assert.equal(callbackRes.headers.get('location'), '/account.html');
  const setCookieHeader = callbackRes.headers.get('set-cookie');
  assert.ok(setCookieHeader.includes('session='));

  const { rows } = await query('SELECT id FROM users WHERE email = $1', [providerEmail]);
  assert.equal(rows.length, 1);

  assert.ok(capturedTokenRequestBody instanceof URLSearchParams);
  assert.equal(capturedTokenRequestBody.get('code'), 'fake-code');
  assert.equal(capturedTokenRequestBody.get('redirect_uri'), 'http://localhost:3000/auth/oauth/google/callback');
  assert.equal(capturedTokenRequestBody.get('grant_type'), 'authorization_code');
  assert.equal(capturedTokenRequestBody.get('client_id'), 'test-google-client-id');

  server.close();
});

test('PROVIDERS.facebook.extractUser always reports emailVerified: false', () => {
  const result = PROVIDERS.facebook.extractUser({ id: 'fb-1', email: 'a@example.com', name: 'A' });
  assert.equal(result.emailVerified, false);

  const resultWithVerifiedLookingField = PROVIDERS.facebook.extractUser({
    id: 'fb-2',
    email: 'b@example.com',
    name: 'B',
    verified: true,
    email_verified: true,
  });
  assert.equal(resultWithVerifiedLookingField.emailVerified, false);
});

test('PROVIDERS.discord.extractUser falls back to username and reports emailVerified from info.verified', () => {
  const withGlobalName = PROVIDERS.discord.extractUser({
    id: 'discord-1',
    email: 'a@example.com',
    global_name: 'Global Name',
    username: 'username1',
    verified: true,
  });
  assert.equal(withGlobalName.name, 'Global Name');
  assert.equal(withGlobalName.emailVerified, true);

  const withoutGlobalName = PROVIDERS.discord.extractUser({
    id: 'discord-2',
    email: 'b@example.com',
    global_name: null,
    username: 'username2',
    verified: false,
  });
  assert.equal(withoutGlobalName.name, 'username2');
  assert.equal(withoutGlobalName.emailVerified, false);
});

test.after(async () => {
  await closePool();
});
