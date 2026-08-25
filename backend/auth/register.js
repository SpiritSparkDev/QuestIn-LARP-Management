import crypto from 'node:crypto';
import { router } from '../routes.js';
import { query } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { sendVerificationEmail } from './mailer.js';
import { readJsonBody } from '../httpBody.js';
import { logger } from '../logger.js';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

router.post('/auth/register', async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  const { email, password, name } = body;
  if (!email || !password || !name) {
    return { status: 400, body: { error: 'email, password, and name are required' } };
  }

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return { status: 409, body: { error: 'email already registered' } };
  }

  const passwordHash = await hashPassword(password);
  let userId;
  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, role, name)
       VALUES ($1, $2, 'participant', $3) RETURNING id`,
      [email, passwordHash, name]
    );
    userId = rows[0].id;
  } catch (err) {
    if (err.code === '23505') {
      return { status: 409, body: { error: 'email already registered' } };
    }
    throw err;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  await query(
    'INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expiresAt]
  );

  try {
    await sendVerificationEmail(email, token);
  } catch (err) {
    logger.error('failed to send verification email', { error: err.message });
  }

  return { status: 201, body: { id: userId, email } };
});

router.get('/auth/verify', async ({ req }) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const token = searchParams.get('token');
  if (!token) return { status: 400, body: { error: 'token is required' } };

  const { rows } = await query(
    'SELECT user_id, expires_at FROM email_verification_tokens WHERE token = $1',
    [token]
  );
  if (rows.length === 0 || new Date(rows[0].expires_at) < new Date()) {
    return { status: 400, body: { error: 'invalid or expired token' } };
  }

  await query('UPDATE users SET email_verified = true WHERE id = $1', [rows[0].user_id]);
  await query('DELETE FROM email_verification_tokens WHERE token = $1', [token]);
  return { status: 200, body: { verified: true } };
});
