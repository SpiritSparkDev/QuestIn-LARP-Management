import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu, requireAnyMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { buildParticipantsCsv } from './exportCsv.js';
import { logAudit } from '../audit/repository.js';
import { query } from '../db.js';
import { canRegisterFor } from '../managedPersons/repository.js';
import {
  registerForEvent,
  setConRole,
  unregisterFromEvent,
  listParticipantsForEvent,
  listRegistrationsForUser,
  checkIn,
  setConPayer,
  checkOut,
  approveRegistration,
  cancelRegistration,
  setStatus,
  getScanLookup,
  updateRegistrationOtFields,
  updateRegistrationExtras,
  notifyRegistrationOtFieldsChanged,
} from './repository.js';

function parseScanCode(code) {
  if (typeof code !== 'string' || code.length < 38) return null;
  const userId = code.slice(-36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  const rest = code.slice(0, -37);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash === -1) return null;
  const eventCode = rest.slice(0, lastDash);
  const groupKey = rest.slice(lastDash + 1);
  if (!eventCode || !groupKey) return null;
  return { eventCode, groupKey, userId };
}

router.post('/events/:id/register', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await registerForEvent(user.id, params.id, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, body.flags, body.priceGroup, body.otFields, user, body.waiverAccepted, { nscData: body.nscData, extras: body.extras, lodgingId: body.lodgingId, lodgingDetails: body.lodgingDetails, deadlineMails: body.deadlineMails === true });
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'WAIVER_NOT_ACCEPTED') return { status: 400, body: { error: err.message } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    if (err.code === 'EVENT_NOT_ACTIVE') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_REQUIRED' || err.code === 'CHARACTER_NOT_ALLOWED') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'INVALID_NSC_AVAILABILITY') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_FLAG') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_PRICE_GROUP' || err.code === 'INVALID_EXTRAS' || err.code === 'INVALID_LODGING' || err.code === 'INVALID_LODGING_DETAILS' || err.code === 'LODGING_DISABLED') return { status: 400, body: { error: err.message } };
    if (err.code === 'EXTRA_SOLD_OUT' || err.code === 'LODGING_FULL') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CHARACTER_DATA') return { status: 400, body: { error: 'invalid character data', details: err.details } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

// An admin/moderator registers another member for an event (same rules as
// the member's own registration, except the waiver -- only the member can accept
// it -- and the active-event gate, which staff is exempt from).
router.post('/events/:id/registrations/:userId', requireAuth(async ({ req, params, user }) => {
  if (!['admin', 'moderator'].includes(user.group.key)) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { rows: userRows } = await query('SELECT 1 FROM users WHERE id = $1', [params.userId]).catch(() => ({ rows: [] }));
  if (userRows.length === 0) return { status: 404, body: { error: 'member not found' } };
  try {
    const registration = await registerForEvent(params.userId, params.id, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, body.flags, body.priceGroup, body.otFields, user, false, { bypassWaiver: true, nscData: body.nscData, extras: body.extras, lodgingId: body.lodgingId, lodgingDetails: body.lodgingDetails });
    await logAudit({ actorId: user.id, action: 'registration.admin_create', details: { eventId: params.id, userId: params.userId, conRole: body.conRole } });
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'ALREADY_REGISTERED' || err.code === 'CHARACTER_ALREADY_REGISTERED' || err.code === 'EXTRA_SOLD_OUT' || err.code === 'LODGING_FULL') return { status: 409, body: { error: err.message } };
    if (['INVALID_CON_ROLE', 'CHARACTER_REQUIRED', 'CHARACTER_NOT_ALLOWED', 'INVALID_NSC_AVAILABILITY', 'INVALID_FLAG', 'INVALID_PRICE_GROUP', 'INVALID_EXTRAS', 'INVALID_LODGING', 'INVALID_LODGING_DETAILS', 'LODGING_DISABLED'].includes(err.code)) {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'INVALID_CHARACTER_DATA') return { status: 400, body: { error: 'invalid character data', details: err.details } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/events/:id/register', requireAuth(async ({ params, user }) => {
  try {
    const { manualReview } = await unregisterFromEvent(user.id, params.id);
    return { status: 200, body: { unregistered: true, manualReview } };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'CANNOT_UNREGISTER') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.get('/registrations', requireAuth(async ({ user }) => {
  const registrations = await listRegistrationsForUser(user.id);
  return { status: 200, body: registrations };
}));

router.get('/events/:id/participants', requireAuth(requireMenu('checkin')(async ({ params, user }) => {
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const schema = await getScCharacterSchema();
  const participants = await listParticipantsForEvent(params.id, { schema, viewer: user });
  return { status: 200, body: participants };
})));

// CSV of the check-in list (optionally just the given ids, in that order).
// Needs the Check-In menu plus the same export permission as the member list;
// the file is built here so the permission and field visibility are enforced
// by the server. Every export is written to the audit log.
router.post('/events/:id/participants/export', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
  if (!user.group.canExportMembers) return { status: 403, body: { error: 'Kein Recht für den CSV-Export.' } };
  const body = (await readJsonBody(req)) ?? {};
  if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string'))) {
    return { status: 400, body: { error: 'ids must be an array of strings' } };
  }
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const schema = await getScCharacterSchema();
  let participants = await listParticipantsForEvent(params.id, { schema, viewer: user });
  if (body.ids) {
    const byId = new Map(participants.map((p) => [p.userId ?? p.invitationId, p]));
    participants = body.ids.map((id) => byId.get(id)).filter(Boolean);
  }
  const otFields = [...await getAccountFieldSchema(), ...await getRegistrationFieldSchema()];
  const csv = buildParticipantsCsv(participants, { otFields, viewer: user });
  await logAudit({
    actorId: user.id,
    action: 'checkin.export',
    details: { count: participants.length, eventId: event.id, eventName: event.name, includesSensitive: user.group.canExportSensitive === true },
  });
  return {
    status: 200,
    isBinary: true,
    body: Buffer.from(csv, 'utf8'),
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="checkin-${new Date().toISOString().slice(0, 10)}.csv"`,
      'X-Content-Type-Options': 'nosniff',
    },
  };
})));

router.get('/events/:eventId/scan-lookup', requireAuth(requireMenu('checkin')(async ({ req, params }) => {
  const code = new URL(req.url, 'http://localhost').searchParams.get('code');
  const parsed = parseScanCode(code);
  if (!parsed) return { status: 400, body: { error: 'invalid or malformed QR code' } };

  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  if (event.code !== parsed.eventCode) {
    return { status: 400, body: { error: 'this code belongs to a different event' } };
  }

  const lookup = await getScanLookup(params.eventId, parsed.userId);
  if (!lookup) return { status: 404, body: { error: 'no registration found for this participant and event' } };
  return { status: 200, body: lookup };
})));

router.post('/events/:id/checkin', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!body.userId) return { status: 400, body: { error: 'userId is required' } };
  try {
    const registration = await checkIn(params.id, body.userId, { paidConfirmed: body.paidConfirmed === true, confirmedBy: user.id });
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_TRANSITION') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

router.post('/events/:id/checkout', requireAuth(requireMenu('checkin')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!body.userId) return { status: 400, body: { error: 'userId is required' } };
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  if (!event.ended_at) return { status: 409, body: { error: 'Check-Out ist erst möglich, wenn das Event beendet wurde.' } };
  try {
    const registration = await checkOut(params.id, body.userId);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_TRANSITION') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

router.post('/events/:id/approve', requireAuth(requireAnyMenu('checkin', 'mitglieder')(async ({ req, params, user }) => {
  if (!user.group.canOverrideCheckinStatus) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!body.userId) return { status: 400, body: { error: 'userId is required' } };
  try {
    const registration = await approveRegistration(params.id, body.userId);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'NO_CHARACTER') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_TRANSITION') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

router.post('/events/:id/cancel', requireAuth(requireAnyMenu('checkin', 'mitglieder')(async ({ req, params, user }) => {
  if (!user.group.canOverrideCheckinStatus) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!body.userId) return { status: 400, body: { error: 'userId is required' } };
  try {
    const registration = await cancelRegistration(params.id, body.userId);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_TRANSITION') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

const VALID_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'waitlisted'];

// Structural keys updateRegistrationOtFields always returns, as opposed to
// OT-schema-driven ones -- see the strip loop below.
const STRUCTURAL_REGISTRATION_KEYS = ['userId', 'eventId', 'status', 'conRole', 'characterId', 'flags', 'checkedInAt', 'checkedOutAt'];

router.put('/events/:id/checkin/:userId', requireAuth(requireAnyMenu('checkin', 'mitglieder')(async ({ req, params, user }) => {
  if (!user.group.canOverrideCheckinStatus) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!VALID_STATUSES.includes(body.status) || !VALID_STATUSES.includes(body.previousStatus)) {
    return { status: 400, body: { error: `status must be one of: ${VALID_STATUSES.join(', ')}` } };
  }
  try {
    const registration = await setStatus(params.id, params.userId, body.status, body.previousStatus);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'STATUS_CONFLICT') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

// Mark (or unmark) a registration as "Con-Zahler": staff only. Participants don't decide this
// themselves -- it follows from the Preisstufe (and the automation after the last deadline).
router.put('/events/:id/registrations/:userId/con-payer', requireAuth(async ({ req, params, user }) => {
  if (!['admin', 'moderator'].includes(user.group.key)) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null || typeof body.conPayer !== 'boolean') return { status: 400, body: { error: 'conPayer (boolean) is required' } };
  try {
    return { status: 200, body: await setConPayer(params.id, params.userId, body.conPayer) };
  } catch (err) {
    if (err.code === 'CON_PAYER_LOCKED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.put('/events/:id/registrations/:userId/con-role', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await setConRole(params.id, params.userId, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, body.flags, user, body.nscData);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_REQUIRED' || err.code === 'CHARACTER_NOT_ALLOWED') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'INVALID_NSC_AVAILABILITY') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_FLAG') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_CHARACTER_DATA') return { status: 400, body: { error: 'invalid character data', details: err.details } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

// Book or change extras of an existing registration: the person themself, a
// manager of a managed person, or an admin/moderator.
router.put('/events/:id/registrations/:userId/extras', requireAuth(async ({ req, params, user }) => {
  const isStaff = ['admin', 'moderator'].includes(user.group.key);
  const isOwner = params.userId === user.id || await canRegisterFor(params.userId, user.id);
  if (!isOwner && !isStaff) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const result = await updateRegistrationExtras(params.id, params.userId, body.extras, { staff: isStaff });
    return { status: 200, body: result };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND' || err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'INVALID_EXTRAS') return { status: 400, body: { error: err.message } };
    if (err.code === 'EXTRA_SOLD_OUT' || err.code === 'EXTRAS_LOCKED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.put('/events/:id/registrations/:userId/ot-fields', requireAuth(async ({ req, params, user }) => {
  const isOwner = params.userId === user.id || await canRegisterFor(params.userId, user.id);
  const isStaff = user.group.visibleMenus.includes('mitglieder');
  if (!isOwner && !isStaff) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  // group.accountFields gates which of the 6 fields staff may edit/see about
  // ANOTHER participant -- mirrors PATCH /members/:id's filterToAllowedFields.
  // The owner editing their own registration is never gated by this list (it
  // exists to restrict what staff may do to OTHERS, not self-service), same
  // as PATCH /account has no such restriction.
  if (!isOwner) {
    const registrationFieldKeys = (await getRegistrationFieldSchema()).map((f) => f.key);
    const disallowed = Object.keys(body).filter((key) => registrationFieldKeys.includes(key) && !user.group.accountFields.includes(key));
    if (disallowed.length > 0) {
      return { status: 400, body: { error: `not permitted to edit: ${disallowed.join(', ')}` } };
    }
  }

  let registration;
  try {
    registration = await updateRegistrationOtFields(params.id, params.userId, body, body.flags);
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_FLAG') return { status: 400, body: { error: err.message } };
    throw err;
  }
  // Fire-and-forget: notifyRegistrationOtFieldsChanged never throws (own
  // top-level try/catch), and awaiting it here would block the response on
  // sending N emails.
  notifyRegistrationOtFieldsChanged(params.id, params.userId);

  // Strip by iterating the RESPONSE's own keys (not the live schema's) so a
  // value orphaned by a since-deleted schema field, or a null-default from
  // DEFAULT_REGISTRATION_FIELD_KEYS, can't leak to unpermitted staff just
  // because it fell off the current schema's key list.
  if (!isOwner) {
    for (const key of Object.keys(registration)) {
      if (!STRUCTURAL_REGISTRATION_KEYS.includes(key) && !user.group.accountFields.includes(key)) delete registration[key];
    }
  }
  return { status: 200, body: registration };
}));

// One-click opt-out from the deadline reminder mails (the link in every mail).
router.post('/public/deadline-optout/:token', async ({ params }) => {
  const { rowCount } = await query(
    'UPDATE registrations SET deadline_mail_optin = false WHERE optout_token = $1',
    [params.token]
  );
  if (rowCount === 0) return { status: 404, body: { error: 'Ungültiger Link.' } };
  return { status: 200, body: { optedOut: true } };
});
