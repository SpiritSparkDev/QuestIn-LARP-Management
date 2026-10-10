import { logAudit } from '../audit/repository.js';
import { query } from '../db.js';
import { cancelRegistration } from '../registrations/repository.js';
import { getMember, updateMember, deactivateMember } from './repository.js';

// Shared by the single-member routes and the bulk endpoints (bulk.js), so both
// apply exactly the same rules. Return null on success, else { status, error }.

// PATCH-style update; a changed group is written to the audit log as role.changed.
// `fields.group` is already the group's id. Returns the member, or null if not found.
export async function updateMemberAudited(actorId, id, fields) {
  const before = fields.group !== undefined ? await getMember(id) : null;
  const member = await updateMember(id, fields);
  if (member && before && before.group.id !== fields.group) {
    await logAudit({ actorId, action: 'role.changed', subjectUserId: id, details: { from: before.group.name, to: member.group.name } });
  }
  return member;
}

// Deactivating also cancels the member's open registrations (pending,
// confirmed, waitlisted) for events that are neither ended nor in the past,
// so a deactivated account no longer takes a place. Checked-in/-out
// registrations and past events stay untouched. Reactivating does not
// restore them.
export async function deactivateChecked(actorId, id) {
  if (id.toLowerCase() === actorId.toLowerCase()) return { status: 400, error: 'cannot deactivate your own account' };
  if (!(await deactivateMember(id))) return { status: 404, error: 'member not found' };
  const { rows } = await query(
    `SELECT r.event_id FROM registrations r JOIN events e ON e.id = r.event_id
     WHERE r.user_id = $1 AND r.status IN ('pending', 'confirmed', 'waitlisted')
       AND e.ended_at IS NULL AND COALESCE(e.end_date, e.event_date) >= CURRENT_DATE`,
    [id]
  );
  for (const { event_id: eventId } of rows) {
    try {
      await cancelRegistration(eventId, id, { actorId, reason: 'member.deactivated' });
    } catch (err) {
      // Status changed in the meantime (e.g. checked in at the desk) -- leave it.
      if (err.code !== 'INVALID_TRANSITION') throw err;
    }
  }
  return null;
}
