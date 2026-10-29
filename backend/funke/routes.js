// Add-on "Funke" (app_settings.funke_enabled): login with a Matrix identity.
// Funke hands over the OpenID token of the signed-in Matrix user
// (client.getOpenIdToken()); we ask the user's homeserver who it belongs to,
// which only works for servers on the admin's allowlist. The result is a
// normal QuestIn session token that Funke sends as "Authorization: Bearer".
import { router } from '../routes.js';
import { query } from '../db.js';
import { readJsonBody } from '../httpBody.js';
import { verifyPassword } from '../crypto/password.js';
import { createSession } from '../auth/sessions.js';
import { findOrCreateOAuthUser } from '../auth/oauth.js';
import { getAppSettings } from '../appSettings/repository.js';
import { rateLimit, isRateLimited } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';

const RATE_LIMIT = { keyPrefix: 'funke-login', maxAttempts: 20, windowMs: 15 * 60 * 1000 };

// Federation endpoint of a server name: .well-known/matrix/server delegation, else the name itself, port 8448 by default
// (Matrix server discovery). FUNKE_INSECURE_HOMESERVER=1 switches to http for development and tests;
// FUNKE_FEDERATION_HOST then overrides the host (a local Synapse serves federation on its client port).
async function federationHost(server) {
  if (process.env.FUNKE_INSECURE_HOMESERVER === '1') return process.env.FUNKE_FEDERATION_HOST || server;
  try {
    const r = await fetch(`https://${server}/.well-known/matrix/server`, { signal: AbortSignal.timeout(5000) });
    const delegated = r.ok ? (await r.json())['m.server'] : null;
    if (typeof delegated === 'string' && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(delegated)) return delegated.includes(':') ? delegated : `${delegated}:8448`;
  } catch { /* no usable delegation: use the server name */ }
  return server.includes(':') ? server : `${server}:8448`;
}

async function matrixIdOf(server, token) {
  const scheme = process.env.FUNKE_INSECURE_HOMESERVER === '1' ? 'http' : 'https';
  const res = await fetch(`${scheme}://${await federationHost(server)}/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const { sub } = await res.json();
  return typeof sub === 'string' && sub.endsWith(`:${server}`) && /^@[^:\s]+:/.test(sub) ? sub : null;
}

async function linkExistingAccount(matrixId, email, password) {
  if (isRateLimited(`login-email:${email}`, 5, 15 * 60 * 1000)) return { status: 429, body: { error: 'Zu viele Versuche. Bitte später erneut versuchen.' } };
  const { rows } = await query('SELECT id, password_hash, deactivated_at FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return { status: 401, body: { error: 'E-Mail oder Passwort falsch.' } };
  }
  if (user.deactivated_at) return { status: 403, body: { error: 'Konto deaktiviert.' } };
  await query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'matrix', $2)", [user.id, matrixId]);
  return { userId: user.id };
}

// Body: { server, token, email?, password?, createNew?, name? }
// Known Matrix id -> session. Unknown: email+password links an existing
// account, createNew creates one, otherwise 409 so Funke can ask which.
router.post('/auth/matrix', rateLimit(RATE_LIMIT)(async ({ req }) => {
  const settings = await getAppSettings();
  if (!settings.funkeEnabled) return { status: 404, body: { error: 'not found' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { server, token, password, createNew, name } = body;
  if (typeof server !== 'string' || typeof token !== 'string') return { status: 400, body: { error: 'server and token are required' } };
  if (!settings.funkeHomeservers.includes(server.toLowerCase())) return { status: 403, body: { error: 'Dieser Matrix-Server ist nicht freigegeben.' } };

  let matrixId;
  try {
    matrixId = await matrixIdOf(server.toLowerCase(), token);
  } catch (err) {
    logger.error('funke openid lookup failed', { server, message: err.message });
    return { status: 502, body: { error: 'Matrix-Server nicht erreichbar.' } };
  }
  if (!matrixId) return { status: 401, body: { error: 'Matrix-Anmeldung ungültig.' } };

  const known = await query("SELECT user_id FROM oauth_accounts WHERE provider = 'matrix' AND provider_user_id = $1", [matrixId]);
  let userId = known.rows[0]?.user_id;
  if (!userId) {
    if (typeof body.email === 'string' && typeof password === 'string') {
      const linked = await linkExistingAccount(matrixId, body.email.toLowerCase(), password);
      if (linked.status) return linked;
      userId = linked.userId;
    } else if (createNew === true) {
      // Placeholder address (never mailed); the person can set a real one under "Konto".
      userId = await findOrCreateOAuthUser('matrix', matrixId, `${matrixId.slice(1)}@matrix.invalid`, typeof name === 'string' && name ? name : matrixId.slice(1).split(':')[0], false);
    } else {
      return { status: 409, body: { error: 'link_required' } };
    }
  }

  const { rows } = await query('SELECT deactivated_at FROM users WHERE id = $1', [userId]);
  if (rows[0]?.deactivated_at) return { status: 403, body: { error: 'Konto deaktiviert.' } };
  const session = await createSession(userId);
  return { status: 200, body: { token: session.token, expiresAt: session.expiresAt, userId } };
}));
