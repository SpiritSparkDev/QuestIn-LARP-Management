import crypto from 'node:crypto';
import { query } from '../db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expiresAt]);
  return { token, expiresAt };
}

export async function getSession(token) {
  const { rows } = await query('SELECT user_id, expires_at, view_as_group_id FROM sessions WHERE token = $1', [token]);
  if (rows.length === 0) return null;
  const session = rows[0];
  if (new Date(session.expires_at) < new Date()) {
    await destroySession(token);
    return null;
  }
  return { userId: session.user_id, expiresAt: session.expires_at, viewAsGroupId: session.view_as_group_id };
}

export async function setSessionViewAs(token, groupId) {
  await query('UPDATE sessions SET view_as_group_id = $2 WHERE token = $1', [token, groupId]);
}

export async function destroySession(token) {
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}
