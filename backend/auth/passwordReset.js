import { router } from '../routes.js';
import { query } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { sendPasswordResetEmail } from './mailer.js';
import { readJsonBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isValidPassword } from '../validation.js';
import { getUserByAccessToken, rotateAccessToken, ensureAccessToken } from './accessTokens.js';

const RESET_RATE_LIMIT = { keyPrefix: 'password-reset', maxAttempts: 10, windowMs: 15 * 60 * 1000 };

// Self-service "Passwort vergessen?": resends the user's existing permanent
// link rather than minting a one-off token -- it's the same link an admin
// can view/send from the members screen, and it only rotates once it's
// actually used (see /auth/password-reset/confirm below).
router.post('/auth/password-reset/request', rateLimit(RESET_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const email = body.email?.toLowerCase();
  if (!email) return { status: 400, body: { error: 'email is required' } };

  const { rows } = await query('SELECT id FROM users WHERE email = $1 AND is_guest = false', [email]);
  if (rows.length > 0) {
    const token = await ensureAccessToken(rows[0].id);
    try {
      await sendPasswordResetEmail(email, token, { userId: rows[0].id });
    } catch (err) {
      logger.error('failed to send password reset email', { error: err.message });
    }
  }

  // Always 200 regardless of whether the email is registered — avoids leaking which emails exist.
  return { status: 200, body: { requested: true } };
}));

router.post('/auth/password-reset/confirm', rateLimit(RESET_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { token, password } = body;
  if (!token || !password) {
    return { status: 400, body: { error: 'token and password are required' } };
  }
  if (!isValidPassword(password)) {
    return { status: 400, body: { error: 'Passwort muss mindestens 8 Zeichen lang sein.' } };
  }

  const user = await getUserByAccessToken(token);
  if (!user) {
    return { status: 400, body: { error: 'Ungültiger oder abgelaufener Link.' } };
  }

  const passwordHash = await hashPassword(password);
  await query('UPDATE users SET password_hash = $1, email_verified = true WHERE id = $2', [passwordHash, user.id]);
  await rotateAccessToken(user.id);
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  return { status: 200, body: { reset: true } };
}));
