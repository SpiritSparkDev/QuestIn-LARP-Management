import crypto from 'node:crypto';
import { router } from '../routes.js';
import { query } from '../db.js';
import { createSession } from './sessions.js';
import { parseCookies, serializeSessionCookie, secureFlag } from './cookies.js';
import { PROVIDERS } from './oauthProviders.js';
import { logger } from '../logger.js';

const STATE_COOKIE = 'oauth_state';
const STATE_MAX_AGE_SECONDS = 600;

function redirectUri(providerName) {
  const base = process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3000';
  return `${base}/auth/oauth/${providerName}/callback`;
}

router.get('/auth/oauth/:provider/start', async ({ params }) => {
  const provider = PROVIDERS[params.provider];
  if (!provider) return { status: 404, body: { error: 'unknown provider' } };

  const state = crypto.randomBytes(24).toString('hex');
  const authUrl = new URL(provider.authUrl);
  authUrl.searchParams.set('client_id', provider.clientId());
  authUrl.searchParams.set('redirect_uri', redirectUri(params.provider));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', provider.scope);
  authUrl.searchParams.set('state', state);

  return {
    status: 302,
    body: {},
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': `${STATE_COOKIE}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${STATE_MAX_AGE_SECONDS}${secureFlag()}`,
    },
  };
});

router.get('/auth/oauth/:provider/callback', async ({ req, params }) => {
  const provider = PROVIDERS[params.provider];
  if (!provider) return { status: 404, body: { error: 'unknown provider' } };

  const { searchParams } = new URL(req.url, 'http://localhost');
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const cookies = parseCookies(req.headers.cookie);

  if (!code || !state || !cookies[STATE_COOKIE] || cookies[STATE_COOKIE] !== state) {
    return { status: 400, body: { error: 'invalid oauth state' } };
  }

  const tokenRes = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: provider.clientId(),
      client_secret: provider.clientSecret(),
      code,
      redirect_uri: redirectUri(params.provider),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    logger.error('oauth token exchange failed', { provider: params.provider, status: tokenRes.status });
    return { status: 502, body: { error: 'oauth provider error' } };
  }
  const tokenBody = await tokenRes.json();

  const userInfoRes = await fetch(provider.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  if (!userInfoRes.ok) {
    logger.error('oauth userinfo fetch failed', { provider: params.provider, status: userInfoRes.status });
    return { status: 502, body: { error: 'oauth provider error' } };
  }
  const info = await userInfoRes.json();
  const { providerUserId, email, name } = provider.extractUser(info);
  if (!email || !providerUserId) {
    return { status: 502, body: { error: 'oauth provider did not return required data' } };
  }

  const userId = await findOrCreateOAuthUser(params.provider, providerUserId, email, name);
  const session = await createSession(userId);

  return {
    status: 302,
    body: {},
    headers: {
      Location: '/account.html',
      'Set-Cookie': [
        serializeSessionCookie(session.token, session.expiresAt),
        `${STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      ],
    },
  };
});

export async function findOrCreateOAuthUser(providerName, providerUserId, email, name) {
  const normalizedEmail = email.toLowerCase();

  const existingOAuth = await query(
    'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2',
    [providerName, providerUserId]
  );
  if (existingOAuth.rows.length > 0) {
    return existingOAuth.rows[0].user_id;
  }

  const existingUser = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  let userId;
  if (existingUser.rows.length > 0) {
    userId = existingUser.rows[0].id;
  } else {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, role, name, email_verified)
       VALUES ($1, NULL, 'participant', $2, true) RETURNING id`,
      [normalizedEmail, name || normalizedEmail]
    );
    userId = rows[0].id;
  }

  await query(
    'INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, $2, $3)',
    [userId, providerName, providerUserId]
  );
  return userId;
}
