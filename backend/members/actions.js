import { logAudit } from '../audit/repository.js';
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

export async function deactivateChecked(actorId, id) {
  if (id.toLowerCase() === actorId.toLowerCase()) return { status: 400, error: 'cannot deactivate your own account' };
  return (await deactivateMember(id)) ? null : { status: 404, error: 'member not found' };
}
