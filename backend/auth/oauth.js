import crypto from 'node:crypto';
import { router } from '../routes.js';
import { query } from '../db.js';
import { createSession } from './sessions.js';
import { parseCookies, serializeSessionCookie, secureFlag } from './cookies.js';
import { PROVIDERS } from './oauthProviders.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { splitFullName } from '../displayName.js';

const OAUTH_START_RATE_LIMIT = { keyPrefix: 'oauth-start', maxAttempts: 10, windowMs: 15 * 60 * 1000 };

const STATE_MAX_AGE_SECONDS = 600;

function stateCookieName(providerName) {
  return `oauth_state_${providerName}`;
}

function redirectUri(providerName) {
  const base = process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3000';
  return `${base}/auth/oauth/${providerName}/callback`;
}

router.get('/auth/oauth/providers', async () => {
  const available = {};
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    available[key] = Boolean(provider.clientId() && provider.clientSecret());
  }
  return { status: 200, body: available };
});

router.get('/auth/oauth/:provider/start', rateLimit(OAUTH_START_RATE_LIMIT)(async ({ params }) => {
  const provider = Object.hasOwn(PROVIDERS, params.provider) ? PROVIDERS[params.provider] : undefined;
  if (!provider) return { status: 404, body: { error: 'unknown provider' } };

  if (!provider.clientId() || !provider.clientSecret()) {
    logger.error('oauth provider not configured', { provider: params.provider });
    return { status: 503, body: { error: 'provider not configured' } };
  }

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
      'Set-Cookie': `${stateCookieName(params.provider)}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${STATE_MAX_AGE_SECONDS}${secureFlag()}`,
    },
  };
}));

router.get('/auth/oauth/:provider/callback', async ({ req, params }) => {
  const provider = Object.hasOwn(PROVIDERS, params.provider) ? PROVIDERS[params.provider] : undefined;
  if (!provider) return { status: 404, body: { error: 'unknown provider' } };

  const cookies = parseCookies(req.headers.cookie);
  const clearStateCookie = `${stateCookieName(params.provider)}=; HttpOnly; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag()}`;

  if (!provider.clientId() || !provider.clientSecret()) {
    logger.error('oauth provider not configured', { provider: params.provider });
    return { status: 503, body: { error: 'provider not configured' }, headers: { 'Set-Cookie': clearStateCookie } };
  }

  const { searchParams } = new URL(req.url, 'http://localhost');
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (!state || !cookies[stateCookieName(params.provider)] || cookies[stateCookieName(params.provider)] !== state) {
    return { status: 400, body: { error: 'invalid oauth state' }, headers: { 'Set-Cookie': clearStateCookie } };
  }

  const providerError = searchParams.get('error');
  if (providerError) {
    logger.info('oauth consent denied or provider error', { provider: params.provider, providerError });
    return {
      status: 302,
      body: {},
      headers: { Location: '/login.html?oauth_error=denied', 'Set-Cookie': clearStateCookie },
    };
  }

  if (!code) {
    return { status: 400, body: { error: 'missing authorization code' }, headers: { 'Set-Cookie': clearStateCookie } };
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
    return { status: 502, body: { error: 'oauth provider error' }, headers: { 'Set-Cookie': clearStateCookie } };
  }
  const tokenBody = await tokenRes.json();

  const userInfoRes = await fetch(provider.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  if (!userInfoRes.ok) {
    logger.error('oauth userinfo fetch failed', { provider: params.provider, status: userInfoRes.status });
    return { status: 502, body: { error: 'oauth provider error' }, headers: { 'Set-Cookie': clearStateCookie } };
  }
  const info = await userInfoRes.json();
  const { providerUserId, email, name, emailVerified } = provider.extractUser(info);
  if (!email || !providerUserId) {
    return {
      status: 502,
      body: { error: 'oauth provider did not return required data' },
      headers: { 'Set-Cookie': clearStateCookie },
    };
  }

  let userId;
  try {
    userId = await findOrCreateOAuthUser(params.provider, providerUserId, email, name, emailVerified);
  } catch (err) {
    if (err.code === 'OAUTH_EMAIL_NOT_VERIFIED') {
      logger.info('oauth link rejected: unverified email', { provider: params.provider });
      return {
        status: 409,
        body: { error: 'this email is not verified by the provider and cannot be linked to an existing account' },
        headers: { 'Set-Cookie': clearStateCookie },
      };
    }
    if (err.code === 'OAUTH_ACCOUNT_DEACTIVATED') {
      logger.info('oauth login rejected: account deactivated', { provider: params.provider });
      return {
        status: 403,
        body: { error: 'this account has been deactivated' },
        headers: { 'Set-Cookie': clearStateCookie },
      };
    }
    throw err;
  }
  const session = await createSession(userId);

  return {
    status: 302,
    body: {},
    headers: {
      Location: '/account.html',
      'Set-Cookie': [serializeSessionCookie(session.token, session.expiresAt), clearStateCookie],
    },
  };
});

export async function findOrCreateOAuthUser(providerName, providerUserId, email, name, emailVerifiedByProvider) {
  const normalizedEmail = email.toLowerCase();

  const existingOAuth = await query(
    `SELECT oauth_accounts.user_id, users.deactivated_at
     FROM oauth_accounts JOIN users ON users.id = oauth_accounts.user_id
     WHERE oauth_accounts.provider = $1 AND oauth_accounts.provider_user_id = $2`,
    [providerName, providerUserId]
  );
  if (existingOAuth.rows.length > 0) {
    if (existingOAuth.rows[0].deactivated_at) {
      const err = new Error('oauth account deactivated');
      err.code = 'OAUTH_ACCOUNT_DEACTIVATED';
      throw err;
    }
    return existingOAuth.rows[0].user_id;
  }

  const existingUser = await query('SELECT id, deactivated_at FROM users WHERE email = $1', [normalizedEmail]);
  let userId;
  if (existingUser.rows.length > 0) {
    if (existingUser.rows[0].deactivated_at) {
      const err = new Error('oauth account deactivated');
      err.code = 'OAUTH_ACCOUNT_DEACTIVATED';
      throw err;
    }
    if (!emailVerifiedByProvider) {
      const err = new Error('oauth email not verified by provider, cannot link to an existing account');
      err.code = 'OAUTH_EMAIL_NOT_VERIFIED';
      throw err;
    }
    userId = existingUser.rows[0].id;
  } else {
    const { firstName, lastName } = splitFullName(name || normalizedEmail);
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, group_id, first_name, last_name, email_verified)
       VALUES ($1, NULL, (SELECT id FROM groups WHERE key = 'sc'), $2, $3, $4) RETURNING id`,
      [normalizedEmail, firstName, lastName, !!emailVerifiedByProvider]
    );
    userId = rows[0].id;
  }

  await query(
    'INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, $2, $3)',
    [userId, providerName, providerUserId]
  );
  return userId;
}
