import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { isValidEmail } from '../validation.js';
import { filterToAllowedFields } from '../members/routes.js';
import { createCharacter } from '../characters/repository.js';
import {
  listManagedPersons, getManagedPersonForRegistration, createManagedPerson, updateManagedPerson, deleteManagedPerson,
  searchClaimablePersons, claimPerson,
} from './repository.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logAudit } from '../audit/repository.js';

const SEARCH_RATE_LIMIT = { keyPrefix: 'managed-search', maxAttempts: 30, windowMs: 15 * 60 * 1000 };

router.get('/managed-persons', requireAuth(async ({ user }) => {
  const persons = await listManagedPersons(user.id);
  return { status: 200, body: persons };
}));

// Must be registered before '/managed-persons/:id'.
router.get('/managed-persons/search', rateLimit(SEARCH_RATE_LIMIT)(requireAuth(async ({ req, user }) => {
  const term = (new URL(req.url, 'http://localhost').searchParams.get('q') ?? '').trim();
  if (term.length < 3) return { status: 400, body: { error: 'Bitte mindestens 3 Zeichen eingeben.' } };
  return { status: 200, body: await searchClaimablePersons(term, user.id) };
})));

router.post('/managed-persons/:id/claim', requireAuth(async ({ params, user }) => {
  const person = await claimPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'Person nicht gefunden oder bereits in einer Gruppe.' } };
  await logAudit({ actorId: user.id, action: 'managed_person.claim', details: { personId: params.id } });
  return { status: 200, body: person };
}));

router.get('/managed-persons/:id', requireAuth(async ({ params, user }) => {
  const person = await getManagedPersonForRegistration(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  return { status: 200, body: person };
}));

router.post('/managed-persons', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { email, firstName = '', lastName = '', nickname, characterName, ...otFields } = body;
  // A person needs just one handle: a nickname, a full name or a character name.
  const charName = typeof characterName === 'string' ? characterName.trim() : '';
  if (!nickname && !(firstName && lastName) && !charName) {
    return { status: 400, body: { error: 'Gib einen Rufnamen, Vor- und Nachnamen oder einen Charakternamen an.' } };
  }
  if (email && !isValidEmail(email)) {
    return { status: 400, body: { error: 'invalid email format' } };
  }

  const disallowed = await filterToAllowedFields(otFields, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to set: ${disallowed.join(', ')}` } };
  }

  try {
    const person = await createManagedPerson({
      ownerId: user.id, groupId: user.group.id, email: email?.toLowerCase(), firstName, lastName,
      nickname: nickname || (firstName && lastName ? undefined : charName), ...otFields,
    });
    if (charName) await createCharacter(person.id, { characterClass: 'sc', name: charName, stub: true });
    return { status: 201, body: person };
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.patch('/managed-persons/:id', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.email && !isValidEmail(body.email)) {
    return { status: 400, body: { error: 'invalid email format' } };
  }

  const disallowed = await filterToAllowedFields(body, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to set: ${disallowed.join(', ')}` } };
  }

  try {
    const fields = body.email !== undefined ? { ...body, email: body.email?.toLowerCase() } : body;
    const person = await updateManagedPerson(params.id, user.id, fields);
    if (!person) return { status: 404, body: { error: 'managed person not found' } };
    return { status: 200, body: person };
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/managed-persons/:id', requireAuth(async ({ req, params, user }) => {
  try {
    const force = new URL(req.url, 'http://localhost').searchParams.get('force') === 'true';
    const deleted = await deleteManagedPerson(params.id, user.id, { force });
    if (!deleted) return { status: 404, body: { error: 'managed person not found' } };
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'HAS_REGISTRATIONS') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));
