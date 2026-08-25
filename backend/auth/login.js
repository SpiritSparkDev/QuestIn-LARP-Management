import { router } from '../routes.js';
import { query } from '../db.js';
import { verifyPassword } from '../crypto/password.js';
import { createSession, destroySession } from './sessions.js';
import { readJsonBody } from '../httpBody.js';
import { parseCookies, serializeSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME } from './cookies.js';

router.post('/auth/login', async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  const { email, password } = body;
  if (!email || !password) {
    return { status: 400, body: { error: 'email and password are required' } };
  }

  const { rows } = await query(
    'SELECT id, password_hash, email_verified FROM users WHERE email = $1',
    [email]
  );
  if (rows.length === 0 || !rows[0].password_hash) {
    return { status: 401, body: { error: 'invalid credentials' } };
  }

  const user = rows[0];
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return { status: 401, body: { error: 'invalid credentials' } };
  }
  if (!user.email_verified) {
    return { status: 403, body: { error: 'email not verified' } };
  }

  const session = await createSession(user.id);
  return {
    status: 200,
    body: { id: user.id },
    headers: { 'Set-Cookie': serializeSessionCookie(session.token, session.expiresAt) },
  };
});

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
