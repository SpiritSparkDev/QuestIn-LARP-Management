import crypto from 'node:crypto';
import { router } from '../routes.js';
import { query } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { sendPasswordResetEmail } from './mailer.js';
import { readJsonBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isValidPassword } from '../validation.js';

const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_RATE_LIMIT = { keyPrefix: 'password-reset', maxAttempts: 10, windowMs: 15 * 60 * 1000 };

router.post('/auth/password-reset/request', rateLimit(RESET_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const email = body.email?.toLowerCase();
  if (!email) return { status: 400, body: { error: 'email is required' } };

  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows.length > 0) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await query(
      'INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, rows[0].id, expiresAt]
    );
    try {
      await sendPasswordResetEmail(email, token);
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

  const { rows } = await query(
    'SELECT user_id, expires_at FROM password_reset_tokens WHERE token = $1',
    [token]
  );
  if (rows.length === 0 || new Date(rows[0].expires_at) < new Date()) {
    return { status: 400, body: { error: 'Ungültiger oder abgelaufener Link.' } };
  }

  const passwordHash = await hashPassword(password);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, rows[0].user_id]);
  await query('DELETE FROM password_reset_tokens WHERE user_id = $1', [rows[0].user_id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [rows[0].user_id]);
  return { status: 200, body: { reset: true } };
}));
