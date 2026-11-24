import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

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
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');

test.beforeEach(resetRateLimits);

// D6: Google, Facebook und Discord sind als Login abgeschaltet, obwohl hier
// Client-IDs gesetzt sind. Start und Callback leiten mit Hinweis zum Login.
for (const provider of ['google', 'facebook', 'discord']) {
  test(`GET /auth/oauth/${provider}/start is disabled (D6) and redirects to the login hint`, async () => {
    await withTestServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/auth/oauth/${provider}/start`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login.html?oauth_error=social_disabled');
      assert.equal(res.headers.get('set-cookie'), null, 'no state cookie, no provider round trip');
    });
  });
}

test('GET /auth/oauth/unknown/start returns 404', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/oauth/unknown/start`, { redirect: 'manual' });
    assert.equal(res.status, 404);
  });
});

test('callback of a disabled provider never contacts the provider and creates no session', async (t) => {
  await withTestServer(async (port) => {
    const originalFetch = globalThis.fetch;
    const contacted = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (!String(url).startsWith(`http://localhost:${port}`)) contacted.push(String(url));
      return originalFetch(url, options);
    });
    const res = await fetch(
      `http://localhost:${port}/auth/oauth/google/callback?code=fake-code&state=s`,
      { headers: { Cookie: 'oauth_state_google=s' }, redirect: 'manual' }
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login.html?oauth_error=social_disabled');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.deepEqual(contacted, []);
  });
});

test('findOrCreateOAuthUser creates a new verified, password-less user on first login', async () => {
  const email = `oauth-new-${crypto.randomUUID()}@example.com`;
  const userId = await findOrCreateOAuthUser('google', `google-${crypto.randomUUID()}`, email, 'OAuth Test', true);
  const { rows } = await query('SELECT email_verified, password_hash, first_name, last_name FROM users WHERE id = $1', [userId]);
  assert.equal(rows[0].email_verified, true);
  assert.equal(rows[0].password_hash, null);
  assert.equal(rows[0].first_name, 'OAuth');
  assert.equal(rows[0].last_name, 'Test');
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

test('findOrCreateOAuthUser stores the provider username and refreshes it on repeat login', async () => {
  const email = `oauth-username-${crypto.randomUUID()}@example.com`;
  const providerUserId = `discord-${crypto.randomUUID()}`;
  await findOrCreateOAuthUser('discord', providerUserId, email, 'Discord Name', true, 'old_handle');
  let { rows } = await query('SELECT username FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2', ['discord', providerUserId]);
  assert.equal(rows[0].username, 'old_handle');

  await findOrCreateOAuthUser('discord', providerUserId, email, 'Discord Name', true, 'new_handle');
  ({ rows } = await query('SELECT username FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2', ['discord', providerUserId]));
  assert.equal(rows[0].username, 'new_handle');
});

test('findOrCreateOAuthUser links to an existing password-registered account by email', async () => {
  const email = `oauth-link-${crypto.randomUUID()}@example.com`;
  const { rows: existing } = await query(
    "INSERT INTO users (email, password_hash, group_id, first_name, last_name, email_verified) VALUES ($1, 'irrelevant-hash', (SELECT id FROM groups WHERE key = 'mitglied'), 'Existing', 'User', true) RETURNING id",
    [email]
  );
  const userId = await findOrCreateOAuthUser('discord', `discord-${crypto.randomUUID()}`, email, 'Discord Name', true);
  assert.equal(userId, existing[0].id);
});

test('findOrCreateOAuthUser rejects linking when provider does not verify the email', async () => {
  const email = `oauth-unverified-${crypto.randomUUID()}@example.com`;
  const { rows: existing } = await query(
    "INSERT INTO users (email, password_hash, group_id, first_name, last_name, email_verified) VALUES ($1, 'irrelevant-hash', (SELECT id FROM groups WHERE key = 'mitglied'), 'Existing', 'User', true) RETURNING id",
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

test('findOrCreateOAuthUser rejects a deactivated account already linked to this provider', async () => {
  const email = `oauth-deactivated-linked-${crypto.randomUUID()}@example.com`;
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'OAuth', 'Deactivated', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [email]
  );
  const userId = rows[0].id;
  await query('INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, $2, $3)', [userId, 'google', `provider-id-${crypto.randomUUID()}`]);
  await query('UPDATE users SET deactivated_at = now() WHERE id = $1', [userId]);

  const providerUserId = (await query('SELECT provider_user_id FROM oauth_accounts WHERE user_id = $1', [userId])).rows[0].provider_user_id;
  await assert.rejects(
    () => findOrCreateOAuthUser('google', providerUserId, email, 'OAuth Deactivated', true),
    (err) => err.code === 'OAUTH_ACCOUNT_DEACTIVATED'
  );
});

test('findOrCreateOAuthUser rejects linking a new provider to a deactivated existing account', async () => {
  const email = `oauth-deactivated-link-${crypto.randomUUID()}@example.com`;
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'OAuth', 'Deactivated', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [email]
  );
  await query('UPDATE users SET deactivated_at = now() WHERE id = $1', [rows[0].id]);

  await assert.rejects(
    () => findOrCreateOAuthUser('google', `new-provider-id-${crypto.randomUUID()}`, email, 'OAuth Deactivated', true),
    (err) => err.code === 'OAUTH_ACCOUNT_DEACTIVATED'
  );
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

test('GET /auth/oauth/:provider/start is rate-limited per IP after 10 attempts in the window', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastRes;
    for (let i = 0; i < 11; i++) {
      lastRes = await fetch(`http://localhost:${port}/auth/oauth/google/start`, { redirect: 'manual' });
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

test('an account that only had a Google login gets back in via "Passwort vergessen" (D6)', async () => {
  const email = `oauth-only-${crypto.randomUUID()}@example.com`;
  const userId = await findOrCreateOAuthUser('google', `google-${crypto.randomUUID()}`, email, 'Nur Google', true);
  await withTestServer(async (port) => {
    const request = await fetch(`http://localhost:${port}/auth/password-reset/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    assert.equal(request.status, 200);
    // The mail carries the user's access token (reset-password.html?token=...).
    const { rows } = await query('SELECT access_token FROM users WHERE id = $1', [userId]);
    const confirm = await fetch(`http://localhost:${port}/auth/password-reset/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rows[0].access_token, password: 'neues-passwort-123' }),
    });
    assert.equal(confirm.status, 200);
    const login = await fetch(`http://localhost:${port}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'neues-passwort-123' }),
    });
    assert.equal(login.status, 200);
    const link = await query("SELECT 1 FROM oauth_accounts WHERE user_id = $1 AND provider = 'google'", [userId]);
    assert.equal(link.rows.length, 1, 'existing oauth_accounts link is kept');
  });
});

test.after(async () => {
  await closePool();
});
