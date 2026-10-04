import { query } from '../db.js';
import { logger } from '../logger.js';

// Records a security-relevant action. Never throws: a failing audit write
// must not break the action it describes, but it is logged loudly.
export async function logAudit({ actorId, action, subjectUserId = null, details = {} }) {
  try {
    await query(
      'INSERT INTO audit_log (actor_id, action, subject_user_id, details) VALUES ($1, $2, $3, $4)',
      [actorId ?? null, action, subjectUserId, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error('failed to write audit log entry', { action, error: err.message });
  }
}

export async function listAudit({ action, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT a.id, a.created_at, a.action, a.details,
            concat_ws(' ', actor.first_name, actor.last_name) AS actor_name,
            concat_ws(' ', subject.first_name, subject.last_name) AS subject_name
     FROM audit_log a
     LEFT JOIN users actor ON actor.id = a.actor_id
     LEFT JOIN users subject ON subject.id = a.subject_user_id
     WHERE ($1::text IS NULL OR a.action = $1)
     ORDER BY a.created_at DESC
     LIMIT $2`,
    [action ?? null, limit]
  );
  return rows.map((r) => ({
    id: r.id, createdAt: r.created_at, action: r.action, details: r.details,
    actorName: r.actor_name || null, subjectName: r.subject_name || null,
  }));
}
