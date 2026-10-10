import { query } from '../db.js';
import { logger } from '../logger.js';

export const EMAIL_LOG_RETENTION_DAYS = 90;
export const EMAIL_LOG_STATUSES = ['sent', 'failed', 'not_configured', 'skipped', 'queued'];

function mapRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    slot: row.slot,
    userId: row.user_id,
    to: row.to_address,
    subject: row.subject,
    status: row.status,
    error: row.error,
  };
}

// Never throws: a broken protocol must not stop the mail itself. Skipped
// without DATABASE_URL, like the rest of backend/auth/mailer.js. `userId`
// goes through a subselect because the recipient may not (or no longer)
// exist as a users row, e.g. a walk-in created on the offline instance.
export async function recordEmail({ slot = null, userId = null, to, subject = '', status, error = null }) {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      `INSERT INTO email_log (slot, user_id, to_address, subject, status, error)
       VALUES ($1, (SELECT id FROM users WHERE id = $2::uuid), $3, $4, $5, $6)`,
      [slot, userId, String(to ?? ''), subject ?? '', status, error]
    );
  } catch (err) {
    logger.error('failed to write email_log', { slot, status, error: err.message });
  }
}

export async function listEmailLog({ search, status, userId, limit = 100, before } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (search) add("(lower(to_address) LIKE '%' || lower($?) || '%' OR lower(subject) LIKE '%' || lower($?) || '%')", search);
  if (status) add('status = $?', status);
  if (userId) add('user_id = $?', userId);
  if (before) add('created_at < $?', before);
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const { rows } = await query(
    `SELECT id, created_at, slot, user_id, to_address, subject, status, error FROM email_log
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(mapRow);
}

// Recent mails to one member: by user_id, or by address for the mails sent
// before the account existed (invitation, Direktanmeldung).
export async function listEmailLogForMember(userId, email, limit = 20) {
  const { rows } = await query(
    `SELECT id, created_at, slot, user_id, to_address, subject, status, error FROM email_log
     WHERE user_id = $1 OR ($2::text IS NOT NULL AND lower(to_address) = lower($2))
     ORDER BY created_at DESC LIMIT $3`,
    [userId, email ?? null, limit]
  );
  return rows.map(mapRow);
}

export async function countEmailLogSince(days, statuses) {
  const { rows } = await query(
    `SELECT status, count(*)::int AS n FROM email_log
     WHERE created_at > now() - make_interval(days => $1) AND status = ANY($2) GROUP BY status`,
    [days, statuses]
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export async function purgeOldEmailLog(days = EMAIL_LOG_RETENTION_DAYS) {
  const { rowCount } = await query('DELETE FROM email_log WHERE created_at < now() - make_interval(days => $1)', [days]);
  return rowCount;
}
