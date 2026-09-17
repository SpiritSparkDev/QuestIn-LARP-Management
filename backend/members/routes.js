import crypto from 'node:crypto';
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listMembers, getMember, updateMember, deactivateMember, reactivateMember, deleteMember } from './repository.js';
import { createInvitation, regenerateToken, getInvitationById, listOpenInvitations, cancelInvitation } from '../invitations/repository.js';
import { sendInvitationEmail, sendVerificationEmail, baseUrl } from '../auth/mailer.js';
import { getAppSettings } from '../appSettings/repository.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { isValidEmail } from '../validation.js';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

async function filterToAllowedFields(body, allowedFields) {
  const schemaKeys = (await getAccountFieldSchema()).map((f) => f.key);
  const accountFieldKeys = ['group', ...schemaKeys];
  return Object.keys(body).filter((key) => accountFieldKeys.includes(key) && !allowedFields.includes(key));
}

router.get('/members', requireAuth(requireMenu('mitglieder')(async ({ req }) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const includeDeactivated = searchParams.get('includeDeactivated') === 'true';
  const members = await listMembers(includeDeactivated);
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

  const disallowed = await filterToAllowedFields(body, user.group.accountFields);
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

router.post('/members/:id/deactivate', requireAuth(requireMenu('mitglieder')(async ({ params, user }) => {
  if (params.id.toLowerCase() === user.id.toLowerCase()) {
    return { status: 400, body: { error: 'cannot deactivate your own account' } };
  }
  const deactivated = await deactivateMember(params.id);
  if (!deactivated) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: { deactivated: true } };
})));

router.post('/members/:id/reactivate', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const reactivated = await reactivateMember(params.id);
  if (!reactivated) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: { reactivated: true } };
})));

router.delete('/members/:id', requireAuth(requireMenu('mitglieder')(async ({ params, user }) => {
  if (params.id.toLowerCase() === user.id.toLowerCase()) {
    return { status: 400, body: { error: 'cannot delete your own account' } };
  }
  const member = await getMember(params.id);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  if (member.status !== 'deactivated') {
    return { status: 400, body: { error: 'only deactivated members can be deleted' } };
  }
  try {
    await deleteMember(params.id);
  } catch (err) {
    if (err.code === '23503') {
      return { status: 409, body: { error: 'member is still referenced (invitations sent or files uploaded) and cannot be deleted' } };
    }
    throw err;
  }
  return { status: 200, body: { deleted: true } };
})));

router.post('/members/:id/resend-verification', requireAuth(requireMenu('mitglieder')(async ({ params, requestId }) => {
  const member = await getMember(params.id);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  if (member.emailVerified) return { status: 400, body: { error: 'email already verified' } };

  await query('DELETE FROM email_verification_tokens WHERE user_id = $1', [params.id]);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  await query(
    'INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, params.id, expiresAt]
  );

  try {
    await sendVerificationEmail(member.email, token);
  } catch (err) {
    logger.error('failed to resend verification email', { requestId, userId: params.id, email: member.email, error: err.message });
    return { status: 502, body: { error: 'failed to send email' } };
  }
  return { status: 200, body: { sent: true } };
})));

const DEFAULT_INVITE_GROUP_KEY = 'mitglied';

router.post('/members/invite', requireAuth(requireMenu('mitglieder')(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { email, firstName, lastName, nickname, group, eventId, sendEmail, ...rest } = body;
  const shouldSendEmail = sendEmail !== false;
  if (!email || !firstName || !lastName) {
    return { status: 400, body: { error: 'email, firstName, and lastName are required' } };
  }
  if (!isValidEmail(email)) {
    return { status: 400, body: { error: 'invalid email format' } };
  }

  // 'group' is gated exactly like every other account field, NOT treated
  // as always-allowed — a group without 'group' in its own account_fields
  // (e.g. moderator, by default) must not be able to hand out a HIGHER group
  // (e.g. admin) to a brand-new invitee just because that account doesn't
  // exist yet. If they omit it, invitees default to 'mitglied' silently; if
  // they try to set it without the permission, that's the same 400 as any
  // other disallowed field.
  const fieldsToCheck = group !== undefined ? { ...rest, group } : rest;
  const disallowed = await filterToAllowedFields(fieldsToCheck, user.group.accountFields);
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

  if (eventId !== undefined && eventId !== null && eventId !== '') {
    const { rows: eventRows } = await query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (eventRows.length === 0) return { status: 400, body: { error: 'unknown event' } };
  }

  const { invitationTtlDays } = await getAppSettings();

  // 'rest' (arbitrary OT fields from the request body) is spread FIRST, so
  // an attacker-supplied 'groupId' (not filtered by filterToAllowedFields --
  // that only guards the account schema's field keys plus 'group', and
  // 'groupId' isn't one of those) can never override the server-computed
  // values that follow.
  const invitation = await createInvitation({
    ...rest,
    email: email.toLowerCase(),
    firstName,
    lastName,
    nickname,
    groupId: groupRows[0].id,
    invitedBy: user.id,
    eventId: eventId || undefined,
    ttlDays: invitationTtlDays,
  });

  let emailSent = null;
  if (shouldSendEmail) {
    emailSent = true;
    try {
      await sendInvitationEmail(invitation.email, invitation.token);
    } catch (err) {
      emailSent = false;
      logger.error('failed to send invitation email', { error: err.message });
    }
  }

  const link = `${baseUrl()}/set-password.html?token=${invitation.token}`;
  return { status: 201, body: { id: invitation.id, email: invitation.email, status: 'invited', emailSent, link } };
})));

router.post('/members/invitations/:id/resend', requireAuth(requireMenu('mitglieder')(async ({ req, params }) => {
  const body = (await readJsonBody(req)) ?? {};
  const shouldSendEmail = body.sendEmail !== false;

  const invitation = await getInvitationById(params.id);
  if (!invitation) return { status: 404, body: { error: 'invitation not found' } };
  if (invitation.redeemedAt) return { status: 409, body: { error: 'invitation already redeemed' } };

  const { invitationTtlDays } = await getAppSettings();
  const updated = await regenerateToken(params.id, invitationTtlDays);
  if (!updated) {
    return { status: 409, body: { error: 'invitation already redeemed' } };
  }
  let emailSent = null;
  if (shouldSendEmail) {
    emailSent = true;
    try {
      await sendInvitationEmail(updated.email, updated.token);
    } catch (err) {
      emailSent = false;
      logger.error('failed to resend invitation email', { error: err.message });
    }
  }
  const link = `${baseUrl()}/set-password.html?token=${updated.token}`;
  return { status: 200, body: { id: updated.id, email: updated.email, status: 'invited', emailSent, link } };
})));

router.post('/members/invitations/:id/cancel', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const cancelled = await cancelInvitation(params.id);
  if (!cancelled) return { status: 409, body: { error: 'invitation already redeemed, cancelled, or not found' } };
  return { status: 200, body: { cancelled: true } };
})));
