import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getManagedPerson } from './repository.js';
import { registerForEvent, unregisterFromEvent, listRegistrationsForUser } from '../registrations/repository.js';

// groups/repository.js isn't imported here -- the managed person's own
// group permissions (canEditCharacters) are needed for registerForEvent's
// EVENT_NOT_ACTIVE gate, same as the ticket-widget guest flow's synthetic
// requestingUser. Looked up fresh rather than trusting any cached value.
import { query } from '../db.js';

async function buildRequestingUser(personId) {
  const { rows } = await query(
    `SELECT groups.key, groups.can_edit_characters FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [personId]
  );
  return { id: personId, group: { key: rows[0].key, canEditCharacters: rows[0].can_edit_characters } };
}

router.post('/managed-persons/:id/events/:eventId/register', requireAuth(async ({ req, params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };

  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const requestingUser = await buildRequestingUser(person.id);
  try {
    const registration = await registerForEvent(
      person.id, params.eventId, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId,
      body.flags, body.priceGroup, body.otFields, requestingUser, body.waiverAccepted
    );
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'WAIVER_NOT_ACCEPTED') return { status: 400, body: { error: err.message } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    if (err.code === 'EVENT_NOT_ACTIVE') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_REQUIRED' || err.code === 'CHARACTER_NOT_ALLOWED' || err.code === 'CHARACTER_CLASS_MISMATCH') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'INVALID_NSC_AVAILABILITY') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_FLAG') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_PRICE_GROUP') return { status: 400, body: { error: err.message } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/managed-persons/:id/events/:eventId/register', requireAuth(async ({ params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  try {
    await unregisterFromEvent(person.id, params.eventId);
    return { status: 200, body: { unregistered: true } };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'CANNOT_UNREGISTER') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.get('/managed-persons/:id/registrations', requireAuth(async ({ params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  const registrations = await listRegistrationsForUser(person.id);
  return { status: 200, body: registrations };
}));
