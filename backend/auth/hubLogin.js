// "Mit QuestIn anmelden": Login über den QuestIn-Hub (OpenID Connect,
// Authorization Code + PKCE). Anders als bei Google & Co. wird ein Hub-Konto
// nie stillschweigend an ein vorhandenes lokales Konto gehängt: gibt es die
// E-Mail lokal schon, muss die Person das mit ihrem lokalen Passwort (oder,
// ohne Passwort, per Mail-Link) bestätigen. Siehe docs/betrieb-hub-login.md.
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { router } from '../routes.js';
import { query } from '../db.js';
import { createSession } from './sessions.js';
import { parseCookies, serializeSessionCookie, secureFlag } from './cookies.js';
import { verifyPassword } from '../crypto/password.js';
import { readJsonBody } from '../httpBody.js';
import { requireAuth } from '../middleware/authenticate.js';
import { rateLimit, isRateLimited } from '../middleware/rateLimit.js';
import { isOffline } from '../appMode.js';
import { logAudit } from '../audit/repository.js';
import { logger } from '../logger.js';
import { splitFullName } from '../displayName.js';
import { sendHubLinkEmail, baseUrl } from './mailer.js';

const FLOW_MAX_AGE_SECONDS = 600;
const LINK_MAX_AGE_SECONDS = 15 * 60;
const LINK_COOKIE = 'hub_link';
const FLOW_COOKIES = ['state', 'nonce', 'pkce', 'return'];
const HTTP_TIMEOUT_MS = 10_000;
const LINK_RATE_LIMIT = { keyPrefix: 'hub-link', maxAttempts: 10, windowMs: 15 * 60 * 1000 };

export function hubConfig() {
  const issuer = process.env.HUB_ISSUER?.trim().replace(/\/+$/, '');
  const clientId = process.env.HUB_CLIENT_ID;
  const clientSecret = process.env.HUB_CLIENT_SECRET;
  return issuer && clientId && clientSecret ? { issuer, clientId, clientSecret } : null;
}

// Only same-origin paths: "/x", never "//host", "/\host" or anything absolute.
export function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

const random = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hubRedirectUri = () => `${process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3000'}/auth/oauth/hub/callback`;

const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureFlag()}`;
const clearCookie = (name) => `${name}=; HttpOnly; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag()}`;
const flowName = (part) => `oauth_${part}_hub`;
const clearFlowCookies = () => FLOW_COOKIES.map((part) => clearCookie(flowName(part)));
const redirect = (location, cookies = []) => ({ status: 302, body: {}, headers: { Location: location, 'Set-Cookie': cookies } });
const loginError = (code, cookies) => redirect(`/login.html?oauth_error=${code}`, cookies);

// Discovery und JWKS je Issuer zwischenspeichern; jose holt neue Schlüssel
// selbst nach, wenn ein unbekannter "kid" auftaucht. Fehler werden nicht gemerkt.
const discoveryCache = new Map();
async function discover(issuer) {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`discovery failed with status ${res.status}`);
  const meta = await res.json();
  if (meta.issuer !== issuer) throw new Error('discovery issuer does not match HUB_ISSUER');
  const entry = { meta, jwks: createRemoteJWKSet(new URL(meta.jwks_uri)) };
  discoveryCache.set(issuer, entry);
  return entry;
}

export async function hubStart({ req }) {
  const config = hubConfig();
  if (!config) {
    logger.error('oauth provider not configured', { provider: 'hub' });
    return { status: 503, body: { error: 'provider not configured' } };
  }
  if (isOffline()) return loginError('offline');

  let meta;
  try {
    ({ meta } = await discover(config.issuer));
  } catch (err) {
    logger.error('hub discovery failed', { error: err.message });
    return loginError('hub_failed');
  }

  const state = random(24);
  const nonce = random(24);
  const verifier = random(32);
  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', hubRedirectUri());
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const returnTo = safeReturnTo(new URL(req.url, 'http://localhost').searchParams.get('returnTo'));
  return redirect(authUrl.toString(), [
    cookie(flowName('state'), state, FLOW_MAX_AGE_SECONDS),
    cookie(flowName('nonce'), nonce, FLOW_MAX_AGE_SECONDS),
    cookie(flowName('pkce'), verifier, FLOW_MAX_AGE_SECONDS),
    returnTo ? cookie(flowName('return'), returnTo, FLOW_MAX_AGE_SECONDS) : clearCookie(flowName('return')),
  ]);
}

// Code tauschen, id_token prüfen, Userinfo holen. Identität ist nur das `sub`
// aus dem geprüften id_token; Userinfo muss dazu passen.
async function fetchHubIdentity(config, code, verifier, nonce) {
  const { meta, jwks } = await discover(config.issuer);
  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64');
  const tokenRes = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: hubRedirectUri(), code_verifier: verifier }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed with status ${tokenRes.status}`);
  const tokens = await tokenRes.json();
  if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') throw new Error('token response incomplete');

  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: config.issuer,
    audience: config.clientId,
    requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
  });
  if (payload.nonce !== nonce) throw new Error('id_token nonce mismatch');

  const infoRes = await fetch(meta.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!infoRes.ok) throw new Error(`userinfo failed with status ${infoRes.status}`);
  const info = await infoRes.json();
  if (info.sub !== payload.sub) throw new Error('userinfo sub does not match id_token');

  return {
    sub: String(payload.sub),
    email: typeof info.email === 'string' ? info.email.trim().toLowerCase() : null,
    emailVerified: info.email_verified === true,
    givenName: info.given_name,
    familyName: info.family_name,
    name: info.name,
  };
}

// Befund 7: die bestätigte Hub-E-Mail ist führend. Lokal übernehmen, wenn sie
// frei ist; gehört sie schon einem anderen lokalen Konto, nichts ändern, nur
// protokollieren (Audit-Log, für Admins sichtbar).
async function adoptHubEmail(userId, oldEmail, newEmail) {
  try {
    const { rowCount } = await query(
      `UPDATE users SET email = $2, email_verified = true
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE email = $2 AND id <> $1)`,
      [userId, newEmail]
    );
    if (rowCount > 0) {
      await logAudit({ actorId: userId, action: 'hub.email_updated', subjectUserId: userId, details: { from: oldEmail, to: newEmail } });
      return;
    }
  } catch (err) {
    if (err.code !== '23505') throw err;
  }
  logger.warn('hub email already used by another local account, not changed', { userId });
  await logAudit({ actorId: userId, action: 'hub.email_conflict', subjectUserId: userId, details: { local: oldEmail, hub: newEmail } });
}

// → { userId } | { linkUserId } | { error }
async function resolveHubUser({ sub, email, emailVerified, givenName, familyName, name }) {
  const known = await query(
    `SELECT o.user_id, u.deactivated_at, u.email FROM oauth_accounts o JOIN users u ON u.id = o.user_id
     WHERE o.provider = 'hub' AND o.provider_user_id = $1`,
    [sub]
  );
  if (known.rows[0]) {
    if (known.rows[0].deactivated_at) return { error: 'deactivated' };
    if (email && emailVerified && email !== known.rows[0].email) await adoptHubEmail(known.rows[0].user_id, known.rows[0].email, email);
    return { userId: known.rows[0].user_id };
  }

  if (!email || !emailVerified) return { error: 'hub_email_unverified' };

  const local = await query(
    `SELECT u.id, u.deactivated_at,
            EXISTS (SELECT 1 FROM oauth_accounts o WHERE o.user_id = u.id AND o.provider = 'hub') AS hub_linked
     FROM users u WHERE u.email = $1`,
    [email]
  );
  if (local.rows[0]) {
    if (local.rows[0].deactivated_at) return { error: 'deactivated' };
    if (local.rows[0].hub_linked) return { error: 'hub_other_account' };
    return { linkUserId: local.rows[0].id };
  }

  const fallback = splitFullName(name || email);
  const firstName = typeof givenName === 'string' && givenName.trim() ? givenName.trim() : fallback.firstName;
  const lastName = typeof familyName === 'string' && familyName.trim() ? familyName.trim() : fallback.lastName;
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, group_id, first_name, last_name, email_verified, access_token)
     VALUES ($1, NULL, (SELECT id FROM groups WHERE key = 'mitglied'), $2, $3, true, $4) RETURNING id`,
    [email, firstName, lastName, crypto.randomBytes(32).toString('hex')]
  );
  const userId = rows[0].id;
  await query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'hub', $2)", [userId, sub]);
  await logAudit({ actorId: userId, action: 'hub.linked', subjectUserId: userId, details: { via: 'new_account' } });
  return { userId };
}

export async function hubCallback({ req }) {
  const config = hubConfig();
  const cookies = parseCookies(req.headers.cookie);
  const clears = clearFlowCookies();
  if (!config) {
    logger.error('oauth provider not configured', { provider: 'hub' });
    return { status: 503, body: { error: 'provider not configured' }, headers: { 'Set-Cookie': clears } };
  }

  const { searchParams } = new URL(req.url, 'http://localhost');
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  if (!state || cookies[flowName('state')] !== state) {
    return { status: 400, body: { error: 'invalid oauth state' }, headers: { 'Set-Cookie': clears } };
  }
  if (searchParams.get('error')) {
    logger.info('oauth consent denied or provider error', { provider: 'hub', providerError: searchParams.get('error') });
    return loginError('denied', clears);
  }
  if (!code) return { status: 400, body: { error: 'missing authorization code' }, headers: { 'Set-Cookie': clears } };
  if (isOffline()) return loginError('offline', clears);

  const nonce = cookies[flowName('nonce')];
  const verifier = cookies[flowName('pkce')];
  if (!nonce || !verifier) return { status: 400, body: { error: 'invalid oauth state' }, headers: { 'Set-Cookie': clears } };

  let identity;
  try {
    identity = await fetchHubIdentity(config, code, verifier, nonce);
  } catch (err) {
    logger.error('hub login failed', { error: err.message });
    return loginError('hub_failed', clears);
  }

  const returnTo = safeReturnTo(cookies[flowName('return')]);
  const result = await resolveHubUser(identity);
  if (result.error) {
    logger.info('hub login rejected', { reason: result.error });
    return loginError(result.error, clears);
  }

  if (result.linkUserId) {
    const token = random(32);
    await query(
      `INSERT INTO hub_link_requests (token_hash, user_id, hub_sub, return_to, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [sha256(token), result.linkUserId, identity.sub, returnTo, LINK_MAX_AGE_SECONDS]
    );
    return redirect('/hub-link.html', [...clears, cookie(LINK_COOKIE, token, LINK_MAX_AGE_SECONDS)]);
  }

  const session = await createSession(result.userId);
  return redirect(returnTo || '/account.html', [...clears, serializeSessionCookie(session.token, session.expiresAt)]);
}

// --- Verknüpfung bestätigen ---------------------------------------------

async function openLinkRequest(column, token) {
  if (typeof token !== 'string' || !token) return null;
  const { rows } = await query(
    `SELECT r.id, r.user_id, r.hub_sub, r.return_to, u.email, u.password_hash, u.deactivated_at
     FROM hub_link_requests r JOIN users u ON u.id = r.user_id
     WHERE r.${column} = $1 AND r.used_at IS NULL AND r.expires_at > now()`,
    [sha256(token)]
  );
  return rows[0] ?? null;
}

const EXPIRED = { status: 410, body: { error: 'Die Anfrage ist abgelaufen. Bitte melde dich erneut mit QuestIn an.' } };
const ALREADY_LINKED_MESSAGE = 'Dieses Konto ist schon mit einem anderen QuestIn-Konto verbunden. Bitte wende dich an die Orga.';

// Einmalig: die Anfrage wird beim Verknüpfen verbraucht.
async function completeLink(request, via) {
  const claimed = await query(
    'UPDATE hub_link_requests SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id',
    [request.id]
  );
  if (claimed.rows.length === 0) return EXPIRED;
  if (request.deactivated_at) return { status: 403, body: { error: 'Konto deaktiviert.' } };
  try {
    await query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'hub', $2)", [request.user_id, request.hub_sub]);
  } catch (err) {
    if (err.code === '23505') return { status: 409, body: { error: ALREADY_LINKED_MESSAGE } };
    throw err;
  }
  await logAudit({ actorId: request.user_id, action: 'hub.linked', subjectUserId: request.user_id, details: { via } });
  const session = await createSession(request.user_id);
  return {
    status: 200,
    body: { redirect: safeReturnTo(request.return_to) || '/account.html' },
    headers: { 'Set-Cookie': [serializeSessionCookie(session.token, session.expiresAt), clearCookie(LINK_COOKIE)] },
  };
}

router.get('/auth/hub/link', async ({ req }) => {
  const request = await openLinkRequest('token_hash', parseCookies(req.headers.cookie)[LINK_COOKIE]);
  if (!request) return EXPIRED;
  return { status: 200, body: { email: request.email, hasPassword: Boolean(request.password_hash) } };
});

router.post('/auth/hub/link', rateLimit(LINK_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const request = await openLinkRequest('token_hash', parseCookies(req.headers.cookie)[LINK_COOKIE]);
  if (!request) return EXPIRED;
  if (!request.password_hash) return { status: 400, body: { error: 'Dein Konto hat kein Passwort. Bitte bestätige per E-Mail.' } };
  if (isRateLimited(`hub-link-request:${request.id}`, 5, LINK_MAX_AGE_SECONDS * 1000)) {
    return { status: 429, body: { error: 'Zu viele Versuche. Bitte später erneut versuchen.' } };
  }
  if (typeof body.password !== 'string' || !(await verifyPassword(body.password, request.password_hash))) {
    return { status: 401, body: { error: 'Passwort falsch.' } };
  }
  return completeLink(request, 'password');
}));

router.post('/auth/hub/link/email', rateLimit(LINK_RATE_LIMIT)(async ({ req, requestId }) => {
  const request = await openLinkRequest('token_hash', parseCookies(req.headers.cookie)[LINK_COOKIE]);
  if (!request) return EXPIRED;
  if (request.password_hash) return { status: 400, body: { error: 'Bitte bestätige mit deinem Passwort.' } };
  const emailToken = random(32);
  await query('UPDATE hub_link_requests SET email_token_hash = $2 WHERE id = $1', [request.id, sha256(emailToken)]);
  try {
    await sendHubLinkEmail(request.email, `${await baseUrl()}/hub-link.html?confirm=${emailToken}`, { userId: request.user_id });
  } catch (err) {
    logger.error('failed to send hub link email', { requestId, error: err.message });
    return { status: 502, body: { error: 'Die E-Mail konnte nicht gesendet werden.' } };
  }
  return { status: 200, body: { sent: true } };
}));

router.post('/auth/hub/link/confirm', rateLimit(LINK_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const request = await openLinkRequest('email_token_hash', body.token);
  if (!request) return EXPIRED;
  return completeLink(request, 'email');
}));

// --- Opt-in: bestehendes Konto in den Hub umziehen (D1/D5) ---------------

async function isHubLinked(userId) {
  const { rows } = await query("SELECT 1 FROM oauth_accounts WHERE user_id = $1 AND provider = 'hub'", [userId]);
  return rows.length > 0;
}

router.get('/auth/hub/status', requireAuth(async ({ user }) => ({
  status: 200,
  body: { available: Boolean(hubConfig()) && !isOffline(), linked: await isHubLinked(user.id) },
})));

router.post('/auth/hub/optin', requireAuth(async ({ req, user, requestId }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.consent !== true) return { status: 400, body: { error: 'Bitte stimme der Übertragung zu.' } };
  const config = hubConfig();
  if (!config || isOffline()) return { status: 503, body: { error: 'QuestIn-Konten sind hier gerade nicht verfügbar.' } };
  if (await isHubLinked(user.id)) return { status: 409, body: { error: 'Dein Konto ist schon mit QuestIn verbunden.' } };

  const { rows } = await query(
    'SELECT email, password_hash, first_name, last_name, nickname, email_verified FROM users WHERE id = $1',
    [user.id]
  );
  const local = rows[0];
  if (!local?.email) return { status: 400, body: { error: 'Dein Konto hat keine E-Mail-Adresse.' } };
  if (!local.first_name?.trim() || !local.last_name?.trim()) {
    return { status: 400, body: { error: 'Bitte trage zuerst Vor- und Nachnamen in deinem Konto ein.' } };
  }

  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64');
  let res;
  try {
    res = await fetch(new URL('/api/v1/accounts/import', config.issuer), {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        email: local.email,
        passwordHash: local.password_hash,
        firstName: local.first_name,
        lastName: local.last_name,
        nickname: local.nickname || null,
        emailVerified: local.email_verified,
        consent: true,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error('hub import request failed', { requestId, error: err.message });
    return { status: 502, body: { error: 'QuestIn ist gerade nicht erreichbar. Bitte versuche es später noch einmal.' } };
  }
  const answer = await res.json().catch(() => ({}));

  if (res.status === 409 && answer.code === 'HUB_ACCOUNT_EXISTS') {
    return { status: 409, body: { error: 'Es gibt schon ein QuestIn-Konto mit deiner E-Mail-Adresse. Melde dich einmal mit QuestIn an, um es zu verknüpfen.', code: 'HUB_ACCOUNT_EXISTS' } };
  }
  if (res.status !== 201 || typeof answer.sub !== 'string') {
    logger.error('hub import rejected', { requestId, status: res.status, error: answer.error });
    return { status: 502, body: { error: 'QuestIn hat die Übertragung abgelehnt. Bitte wende dich an die Orga.' } };
  }

  try {
    await query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'hub', $2)", [user.id, answer.sub]);
  } catch (err) {
    if (err.code === '23505') return { status: 409, body: { error: ALREADY_LINKED_MESSAGE } };
    throw err;
  }
  await logAudit({ actorId: user.id, action: 'hub.optin', subjectUserId: user.id, details: { sub: answer.sub } });
  return { status: 200, body: { linked: true } };
}));
