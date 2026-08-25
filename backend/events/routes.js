import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { createEvent, getEvent, listEvents, updateEvent, activateEvent } from './repository.js';

function isValidCharacterFormSchema(schema) {
  return Array.isArray(schema) && schema.every(
    (field) => field && typeof field === 'object' && typeof field.key === 'string' && field.key.length > 0
  );
}

router.post('/events', requireAuth(requireRole('admin')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, characterFormSchema } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (characterFormSchema !== undefined && !isValidCharacterFormSchema(characterFormSchema)) {
    return { status: 400, body: { error: 'characterFormSchema must be an array of objects each with a string "key"' } };
  }
  const event = await createEvent({ name, eventDate, characterFormSchema });
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

router.put('/events/:id', requireAuth(requireRole('admin')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { characterFormSchema } = body;
  if (characterFormSchema !== undefined && !isValidCharacterFormSchema(characterFormSchema)) {
    return { status: 400, body: { error: 'characterFormSchema must be an array of objects each with a string "key"' } };
  }
  const event = await updateEvent(params.id, body);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));

router.post('/events/:id/activate', requireAuth(requireRole('admin')(async ({ params }) => {
  const event = await activateEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));
