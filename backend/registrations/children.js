// Add-on "Kinder" (app_settings.children_enabled): a managed person can be
// marked as a child (users.is_child). The person who manages them
// (managed_by_user_id) is the parent or guardian. Rules while the add-on is on:
// - a child can only be registered for an event while the guardian holds a
//   registration there that is not cancelled;
// - children take a place in the participant limits only if
//   app_settings.children_count_capacity is set (see capacity.js).
import { query } from '../db.js';

export async function isChildUser(userId, run = query) {
  const { rows } = await run('SELECT is_child FROM users WHERE id = $1', [userId]);
  return rows[0]?.is_child === true;
}

// Throws GUARDIAN_NOT_REGISTERED when `userId` is a child whose guardian is not
// registered for `eventId`. No-op for everyone else or with the add-on off.
export async function assertGuardianRegistered(eventId, userId, childrenEnabled) {
  if (!childrenEnabled) return;
  const { rows } = await query(
    `SELECT u.is_child, u.managed_by_user_id,
            EXISTS (SELECT 1 FROM registrations r
                    WHERE r.event_id = $1 AND r.user_id = u.managed_by_user_id AND r.status <> 'cancelled') AS guardian_registered
     FROM users u WHERE u.id = $2`,
    [eventId, userId]
  );
  const person = rows[0];
  if (!person?.is_child || person.guardian_registered) return;
  const err = new Error('Kinder können nur angemeldet werden, wenn das zuständige Elternteil bzw. die sorgeberechtigte Person selbst für dieses Event angemeldet ist.');
  err.code = 'GUARDIAN_NOT_REGISTERED';
  throw err;
}

// The guardian's registrations of `eventId`'s children that are still open
// (not cancelled) -- for the warning when the guardian cancels.
export async function openChildRegistrations(eventId, guardianId) {
  const { rows } = await query(
    `SELECT u.id, u.first_name, u.last_name, u.nickname FROM registrations r JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1 AND u.managed_by_user_id = $2 AND u.is_child AND r.status <> 'cancelled'
     ORDER BY u.first_name, u.last_name`,
    [eventId, guardianId]
  );
  return rows;
}
