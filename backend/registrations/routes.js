import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import {
  registerForEvent,
  setConRole,
  unregisterFromEvent,
  listParticipantsForEvent,
  listRegistrationsForUser,
  checkIn,
  checkOut,
  approveRegistration,
  cancelRegistration,
  setStatus,
  getScanLookup,
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
    const registration = await registerForEvent(user.id, params.id, body.conRole, user);
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/events/:id/register', requireAuth(async ({ params, user }) => {
  try {
    await unregisterFromEvent(user.id, params.id);
    return { status: 200, body: { unregistered: true } };
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
  const participants = await listParticipantsForEvent(params.id, { schema: event.character_form_schema, viewer: user });
  return { status: 200, body: participants };
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

router.post('/events/:id/checkin', requireAuth(requireMenu('checkin')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!body.userId) return { status: 400, body: { error: 'userId is required' } };
  try {
    const registration = await checkIn(params.id, body.userId);
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
  try {
    const registration = await checkOut(params.id, body.userId);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_TRANSITION') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

router.post('/events/:id/approve', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
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

router.post('/events/:id/cancel', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
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

const VALID_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'];

router.put('/events/:id/checkin/:userId', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
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

router.put('/events/:id/registrations/:userId/con-role', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await setConRole(params.id, params.userId, body.conRole, user);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    throw err;
  }
}));
