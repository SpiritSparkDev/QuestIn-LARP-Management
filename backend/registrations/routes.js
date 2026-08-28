import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import {
  registerForEvent,
  unregisterFromEvent,
  listParticipantsForEvent,
  listRegistrationsForUser,
  checkIn,
  checkOut,
  setStatus,
} from './repository.js';

router.post('/events/:id/register', requireAuth(async ({ params, user }) => {
  try {
    const registration = await registerForEvent(user.id, params.id);
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
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

router.get('/events/:id/participants', requireAuth(requireMenu('checkin')(async ({ params }) => {
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const participants = await listParticipantsForEvent(params.id);
  return { status: 200, body: participants };
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

const VALID_STATUSES = ['registered', 'checked_in', 'checked_out'];

router.put('/events/:id/checkin/:userId', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
  if (!user.group.canOverrideCheckinStatus) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!VALID_STATUSES.includes(body.status)) {
    return { status: 400, body: { error: `status must be one of: ${VALID_STATUSES.join(', ')}` } };
  }
  try {
    const registration = await setStatus(params.id, params.userId, body.status);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    throw err;
  }
})));
