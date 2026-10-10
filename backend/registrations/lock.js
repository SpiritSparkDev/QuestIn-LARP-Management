import { query } from '../db.js';

export const CON_ROLE_LABELS = {
  sc: 'SC', nsc: 'NSC', ticket: 'Direktanmeldung', helfer: 'Helfer', hilfs_orga: 'Hilfs-Orga', orga: 'Orga',
};

// Admins and moderators register others past the lock (same staff notion as
// POST /events/:id/registrations/:userId).
export function bypassesRegistrationLock(requestingUser) {
  return ['admin', 'moderator'].includes(requestingUser?.group?.key);
}

// Why the event's manual lock covers a registration of `conRole` by a member
// of account role `group` ({ key, name }), or null if it doesn't.
export function registrationLockReason(event, conRole, group) {
  if ((event.registration_locked_con_roles ?? []).includes(conRole)) {
    return `Die Anmeldung als ${CON_ROLE_LABELS[conRole] ?? conRole} ist für „${event.name}“ derzeit gesperrt.`;
  }
  if (group && (event.registration_locked_groups ?? []).includes(group.key)) {
    return `Für die Rolle „${group.name}“ ist die Anmeldung zu „${event.name}“ derzeit gesperrt.`;
  }
  return null;
}

export async function accountGroupOf(userId) {
  const { rows } = await query('SELECT g.key, g.name FROM users u JOIN groups g ON g.id = u.group_id WHERE u.id = $1', [userId]);
  return rows[0] ?? null;
}

// For a new registration: null = not locked, 'waitlist' = take it onto the
// waitlist (event's lock mode), otherwise throws REGISTRATION_LOCKED.
// `forceBlock` refuses even in waitlist mode (a role change can't be half done).
export async function checkRegistrationLock(event, userId, conRole, requestingUser, { forceBlock = false } = {}) {
  if (bypassesRegistrationLock(requestingUser)) return null;
  const locksGroups = (event.registration_locked_groups ?? []).length > 0;
  const reason = registrationLockReason(event, conRole, locksGroups ? await accountGroupOf(userId) : null);
  if (!reason) return null;
  if (event.registration_lock_mode === 'waitlist' && !forceBlock) return 'waitlist';
  const err = new Error(reason);
  err.code = 'REGISTRATION_LOCKED';
  throw err;
}
