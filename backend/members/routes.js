import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listMembers, getMember, updateMember } from './repository.js';
import { createInvitation, regenerateToken, getInvitationById, listOpenInvitations } from '../invitations/repository.js';
import { sendInvitationEmail } from '../auth/mailer.js';
import { logger } from '../logger.js';
import { query } from '../db.js';

const ACCOUNT_FIELD_KEYS = ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'group'];

function filterToAllowedFields(body, allowedFields) {
  const disallowed = Object.keys(body).filter((key) => ACCOUNT_FIELD_KEYS.includes(key) && !allowedFields.includes(key));
  return disallowed;
}

router.get('/members', requireAuth(requireMenu('mitglieder')(async () => {
  const members = await listMembers();
  const invitations = await listOpenInvitations();
  const invited = invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    name: inv.name,
    status: 'invited',
    expired: new Date(inv.expiresAt) < new Date(),
  }));
  return { status: 200, body: [...members, ...invited] };
})));

router.get('/members/:id', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const member = await getMember(params.id);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: member };
})));

router.patch('/members/:id', requireAuth(requireMenu('mitglieder')(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  const disallowed = filterToAllowedFields(body, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to edit: ${disallowed.join(', ')}` } };
  }

  const fields = { ...body };
  if (fields.group !== undefined) {
    const { rows } = await query('SELECT id FROM groups WHERE key = $1', [fields.group]);
    if (rows.length === 0) return { status: 400, body: { error: 'unknown group' } };
    fields.group = rows[0].id;
  }

  const member = await updateMember(params.id, fields);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: member };
})));

const DEFAULT_INVITE_GROUP_KEY = 'sc';

router.post('/members/invite', requireAuth(requireMenu('mitglieder')(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { email, name, group, ...rest } = body;
  if (!email || !name) {
    return { status: 400, body: { error: 'email and name are required' } };
  }

  // 'group' is gated exactly like every other account field, NOT treated
  // as always-allowed — a group without 'group' in its own account_fields
  // (e.g. orga, by default) must not be able to hand out a HIGHER group
  // (e.g. admin) to a brand-new invitee just because that account doesn't
  // exist yet. If they omit it, invitees default to 'sc' silently; if they
  // try to set it without the permission, that's the same 400 as any other
  // disallowed field.
  const fieldsToCheck = group !== undefined ? { ...rest, group } : rest;
  const disallowed = filterToAllowedFields(fieldsToCheck, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to set: ${disallowed.join(', ')}` } };
  }

  const { rows: existingUser } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existingUser.length > 0) {
    return { status: 409, body: { error: 'a member with this email already exists' } };
  }

  const groupKey = group ?? DEFAULT_INVITE_GROUP_KEY;
  const { rows: groupRows } = await query('SELECT id FROM groups WHERE key = $1', [groupKey]);
  if (groupRows.length === 0) return { status: 400, body: { error: 'unknown group' } };

  const invitation = await createInvitation({
    email: email.toLowerCase(),
    name,
    groupId: groupRows[0].id,
    invitedBy: user.id,
    address: rest.address,
    birthdate: rest.birthdate,
    phone: rest.phone,
    emergencyContact: rest.emergencyContact,
    medicalNotes: rest.medicalNotes,
  });

  try {
    await sendInvitationEmail(invitation.email, invitation.token);
  } catch (err) {
    logger.error('failed to send invitation email', { error: err.message });
  }

  return { status: 201, body: { id: invitation.id, email: invitation.email, status: 'invited' } };
})));

router.post('/members/invitations/:id/resend', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const invitation = await getInvitationById(params.id);
  if (!invitation) return { status: 404, body: { error: 'invitation not found' } };
  if (invitation.redeemedAt) return { status: 409, body: { error: 'invitation already redeemed' } };

  const updated = await regenerateToken(params.id);
  try {
    await sendInvitationEmail(updated.email, updated.token);
  } catch (err) {
    logger.error('failed to resend invitation email', { error: err.message });
  }
  return { status: 200, body: { id: updated.id, email: updated.email, status: 'invited' } };
})));
