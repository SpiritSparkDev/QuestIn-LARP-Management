import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { createEvent, getEvent, listEvents, updateEvent, activateEvent, deleteEvent } from './repository.js';
import { maybePromoteFromWaitlist } from '../registrations/repository.js';

router.post('/events', requireAuth(requireMenu('events')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, code, capacity } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (capacity !== undefined && capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  const event = await createEvent({ name, eventDate, code, capacity });
  return { status: 201, body: event };
})));

router.get('/events', requireAuth(async () => {
  const events = await listEvents();
  return { status: 200, body: events };
}));

router.get('/events/:id', requireAuth(async ({ params }) => {
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
}));

router.put('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.capacity !== undefined && body.capacity !== null && (!Number.isInteger(body.capacity) || body.capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  const before = await getEvent(params.id);
  if (!before) return { status: 404, body: { error: 'event not found' } };
  const event = await updateEvent(params.id, body);

  const effective = (c) => (c === null ? Infinity : c);
  if (effective(event.capacity) > effective(before.capacity)) {
    await maybePromoteFromWaitlist(params.id);
  }
  return { status: 200, body: await getEvent(params.id) };
})));

router.post('/events/:id/activate', requireAuth(requireMenu('events')(async ({ params }) => {
  const event = await activateEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));

router.delete('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = (await readJsonBody(req)) ?? {};
  try {
    const deleted = await deleteEvent(params.id, { force: !!body.force, notify: !!body.notify });
    if (!deleted) return { status: 404, body: { error: 'event not found' } };
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'EVENT_HAS_REGISTRATIONS') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));
