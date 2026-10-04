import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { buildMembersCsv } from './exportCsv.js';
import { getEvent } from '../events/repository.js';
import { readJsonBody } from '../httpBody.js';
import { listMembers, getMember, updateMember, deactivateMember, reactivateMember, deleteMember } from './repository.js';
import { createInvitation, regenerateToken, getInvitationById, listOpenInvitations, cancelInvitation } from '../invitations/repository.js';
import { sendInvitationEmail, sendVerificationEmail, sendPasswordResetEmail, baseUrl } from '../auth/mailer.js';
import { getAppSettings } from '../appSettings/repository.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { isValidEmail } from '../validation.js';
import { ensureAccessToken } from '../auth/accessTokens.js';

export async function filterToAllowedFields(body, allowedFields) {
  const schemaKeys = (await getAccountFieldSchema()).map((f) => f.key);
  const accountFieldKeys = ['group', ...schemaKeys];
  return Object.keys(body).filter((key) => accountFieldKeys.includes(key) && !allowedFields.includes(key));
}

// The member list as the page shows it: accounts plus open invitations.
async function listMembersAndInvitations(includeDeactivated) {
  const members = await listMembers(includeDeactivated);
  const invitations = await listOpenInvitations();
  const invited = invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    name: inv.name,
    status: 'invited',
    expired: new Date(inv.expiresAt) < new Date(),
  }));
  return [...members, ...invited];
}

router.get('/members', requireAuth(requireMenu('mitglieder')(async ({ req }) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const includeDeactivated = searchParams.get('includeDeactivated') === 'true';
  return { status: 200, body: await listMembersAndInvitations(includeDeactivated) };
})));

// CSV export of (a selection of) the member list. Needs its own group
// permission on top of the Mitglieder menu; the CSV is built here, not in
// the browser, so the permission and the per-group field visibility are
// enforced by the server.
router.post('/members/export', requireAuth(requireMenu('mitglieder')(async ({ req, user }) => {
  if (!user.group.canExportMembers) return { status: 403, body: { error: 'Kein Recht für den CSV-Export.' } };
  const body = (await readJsonBody(req)) ?? {};
  if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string'))) {
    return { status: 400, body: { error: 'ids must be an array of strings' } };
  }
  const event = body.eventId ? await getEvent(body.eventId) : null;
  if (body.eventId && !event) return { status: 404, body: { error: 'event not found' } };

  let members = await listMembersAndInvitations(true);
  if (body.ids) {
    // Keep the order of the list as shown on screen.
    const byId = new Map(members.map((m) => [m.id, m]));
    members = body.ids.map((id) => byId.get(id)).filter(Boolean);
  }
  const csv = buildMembersCsv(members, { accountSchema: await getAccountFieldSchema(), viewer: user, event });
  return {
    status: 200,
    isBinary: true,
    body: Buffer.from(csv, 'utf8'),
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mitglieder-${new Date().toISOString().slice(0, 10)}.csv"`,
      'X-Content-Type-Options': 'nosniff',
    },
  };
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

// The member's permanent access link (see backend/auth/accessTokens.js):
// confirms their email while unverified, or resets their password once
// verified -- the admin can look it up and (re)send it at any time, not
// just while the account is still unconfirmed.
router.get('/members/:id/access-link', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const member = await getMember(params.id);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  if (member.isGuest) return { status: 400, body: { error: 'guest accounts have no access link' } };

  const token = await ensureAccessToken(params.id);
  const page = member.emailVerified ? 'reset-password' : 'verify';
  const link = `${await baseUrl()}/${page}.html?token=${token}`;
  return { status: 200, body: { link, emailVerified: member.emailVerified } };
})));

router.post('/members/:id/access-link/send', requireAuth(requireMenu('mitglieder')(async ({ params, requestId }) => {
  const member = await getMember(params.id);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  if (member.isGuest) return { status: 400, body: { error: 'guest accounts have no access link' } };

  const token = await ensureAccessToken(params.id);
  try {
    if (member.emailVerified) {
      await sendPasswordResetEmail(member.email, token, { userId: params.id });
    } else {
      await sendVerificationEmail(member.email, token, { userId: params.id });
    }
  } catch (err) {
    logger.error('failed to send access link email', { requestId, userId: params.id, email: member.email, error: err.message });
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
      await sendInvitationEmail(invitation.email, invitation.token, { account: invitation });
    } catch (err) {
      emailSent = false;
      logger.error('failed to send invitation email', { error: err.message });
    }
  }

  const link = `${await baseUrl()}/set-password.html?token=${invitation.token}`;
  return { status: 201, body: { id: invitation.id, email: invitation.email, status: 'invited', emailSent, link } };
})));

// Converts an existing GUEST member (no login access, created via the public
// ticket widget) into a regular full account -- deliberately a separate
// endpoint from /members/invite above, which explicitly rejects an email
// that already has a users row (routes.js ~149-152); here that's exactly
// the precondition. The invitation this creates carries `userId`, which
// makes /auth/invite/redeem update the existing row in place instead of
// inserting a new one (see backend/auth/invite.js).
router.post('/members/:id/generate-conversion-link', requireAuth(requireMenu('mitglieder')(async ({ params, user }) => {
  const member = await getMember(params.id);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  if (!member.isGuest) return { status: 400, body: { error: 'member is not a guest account' } };

  const { invitationTtlDays } = await getAppSettings();
  const invitation = await createInvitation({
    userId: member.id,
    email: member.email,
    firstName: member.firstName,
    lastName: member.lastName,
    nickname: member.nickname,
    groupId: member.group.id,
    invitedBy: user.id,
    ttlDays: invitationTtlDays,
  });

  const link = `${await baseUrl()}/set-password.html?token=${invitation.token}`;
  return { status: 201, body: { id: invitation.id, link } };
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
      await sendInvitationEmail(updated.email, updated.token, { account: updated });
    } catch (err) {
      emailSent = false;
      logger.error('failed to resend invitation email', { error: err.message });
    }
  }
  const link = `${await baseUrl()}/set-password.html?token=${updated.token}`;
  return { status: 200, body: { id: updated.id, email: updated.email, status: 'invited', emailSent, link } };
})));

router.post('/members/invitations/:id/cancel', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const cancelled = await cancelInvitation(params.id);
  if (!cancelled) return { status: 409, body: { error: 'invitation already redeemed, cancelled, or not found' } };
  return { status: 200, body: { cancelled: true } };
})));
