import { query } from '../db.js';

export const CON_ROLE_LABELS = {
  sc: 'SC', nsc: 'NSC', ticket: 'Direktanmeldung', helfer: 'Helfer', hilfs_orga: 'Hilfs-Orga', orga: 'Orga',
};

// Admins and moderators register others past the lock (same staff notion as
// POST /events/:id/registrations/:userId).
export function bypassesRegistrationLock(requestingUser) {
  return ['admin', 'moderator'].includes(requestingUser?.group?.key);
}

// Throws REGISTRATION_LOCKED if the event's manual lock covers `conRole` or
// the account role of the person being registered (`userId`).
export async function assertNotRegistrationLocked(event, userId, conRole, requestingUser) {
  if (bypassesRegistrationLock(requestingUser)) return;
  const lockedRoles = event.registration_locked_con_roles ?? [];
  const lockedGroups = event.registration_locked_groups ?? [];
  if (lockedRoles.includes(conRole)) {
    throw locked(`Die Anmeldung als ${CON_ROLE_LABELS[conRole] ?? conRole} ist für „${event.name}“ derzeit gesperrt.`);
  }
  if (lockedGroups.length === 0) return;
  const { rows } = await query('SELECT g.key, g.name FROM users u JOIN groups g ON g.id = u.group_id WHERE u.id = $1', [userId]);
  if (rows[0] && lockedGroups.includes(rows[0].key)) {
    throw locked(`Für die Rolle „${rows[0].name}“ ist die Anmeldung zu „${event.name}“ derzeit gesperrt.`);
  }
}

function locked(message) {
  const err = new Error(message);
  err.code = 'REGISTRATION_LOCKED';
  return err;
}
