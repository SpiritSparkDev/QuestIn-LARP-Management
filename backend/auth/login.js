import { router } from '../routes.js';
import { query } from '../db.js';
import { verifyPassword } from '../crypto/password.js';
import { createSession, destroySession } from './sessions.js';
import { readJsonBody } from '../httpBody.js';
import { parseCookies, serializeSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME } from './cookies.js';
import { rateLimit, isRateLimited } from '../middleware/rateLimit.js';

const LOGIN_IP_RATE_LIMIT = { keyPrefix: 'login-ip', maxAttempts: 10, windowMs: 15 * 60 * 1000 };
const LOGIN_EMAIL_MAX_ATTEMPTS = 5;
const LOGIN_EMAIL_WINDOW_MS = 15 * 60 * 1000;

router.post('/auth/login', rateLimit(LOGIN_IP_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  const { password } = body;
  const email = body.email?.toLowerCase();
  if (!email || !password) {
    return { status: 400, body: { error: 'email and password are required' } };
  }

  if (isRateLimited(`login-email:${email}`, LOGIN_EMAIL_MAX_ATTEMPTS, LOGIN_EMAIL_WINDOW_MS)) {
    return { status: 429, body: { error: 'Zu viele Versuche. Bitte später erneut versuchen.' } };
  }

  const { rows } = await query(
    'SELECT id, password_hash, email_verified, deactivated_at FROM users WHERE email = $1',
    [email]
  );
  if (rows.length === 0 || !rows[0].password_hash) {
    return { status: 401, body: { error: 'E-Mail oder Passwort falsch.' } };
  }

  const user = rows[0];
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return { status: 401, body: { error: 'E-Mail oder Passwort falsch.' } };
  }
  if (user.deactivated_at) {
    return { status: 403, body: { error: 'Konto deaktiviert.' } };
  }
  if (!user.email_verified) {
    return { status: 403, body: { error: 'E-Mail-Adresse noch nicht bestätigt.' } };
  }

  const session = await createSession(user.id);
  return {
    status: 200,
    body: { id: user.id },
    headers: { 'Set-Cookie': serializeSessionCookie(session.token, session.expiresAt) },
  };
}));

router.post('/auth/logout', async ({ req }) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) await destroySession(token);

  return {
    status: 200,
    body: { loggedOut: true },
    headers: { 'Set-Cookie': clearSessionCookie() },
  };
});
