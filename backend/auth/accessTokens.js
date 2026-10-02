// A permanent per-user token that doubles as an email-confirmation link and
// a "forgot password" link: it never expires on its own, but every use
// (confirming the email or setting a new password) rotates it to a fresh
// value, so a used link can't be replayed. Admins can view and resend a
// member's current link at any time (see backend/members/routes.js).
import crypto from 'node:crypto';
import { query } from '../db.js';

export function generateAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function getUserByAccessToken(token) {
  const { rows } = await query(
    'SELECT id, email, email_verified FROM users WHERE access_token = $1 AND deactivated_at IS NULL',
    [token]
  );
  return rows[0] ?? null;
}

export async function rotateAccessToken(userId) {
  const token = generateAccessToken();
  await query('UPDATE users SET access_token = $2 WHERE id = $1', [userId, token]);
  return token;
}

// Lazily backfills a token for rows that predate this column (or were
// inserted directly, e.g. by tests) instead of failing on a NULL token.
export async function ensureAccessToken(userId) {
  const { rows } = await query('SELECT access_token FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) return null;
  if (rows[0].access_token) return rows[0].access_token;
  return rotateAccessToken(userId);
}
