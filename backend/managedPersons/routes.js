import { router } from '../routes.js';
import { requireAuth, requireGroupManager } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { isValidEmail } from '../validation.js';
import { filterToAllowedFields } from '../members/routes.js';
import { createCharacter } from '../characters/repository.js';
import {
  listManagedPersons, getManagedPersonForRegistration, createManagedPerson, updateManagedPerson,
  searchClaimablePersons, claimPerson, releasePerson,
} from './repository.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logAudit } from '../audit/repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEARCH_RATE_LIMIT = { keyPrefix: 'managed-search', maxAttempts: 30, windowMs: 15 * 60 * 1000 };

router.get('/managed-persons', requireAuth(async ({ user }) => {
  const persons = await listManagedPersons(user.id);
  return { status: 200, body: persons };
}));

// Must be registered before '/managed-persons/:id'.
router.get('/managed-persons/search', rateLimit(SEARCH_RATE_LIMIT)(requireGroupManager(async ({ req, user }) => {
  const term = (new URL(req.url, 'http://localhost').searchParams.get('q') ?? '').trim();
  if (term.length < 3) return { status: 400, body: { error: 'Bitte mindestens 3 Zeichen eingeben.' } };
  return { status: 200, body: await searchClaimablePersons(term, user.id) };
})));

router.post('/managed-persons/:id/claim', requireGroupManager(async ({ params, user }) => {
  const person = await claimPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'Person nicht gefunden oder bereits in einer Gruppe.' } };
  await logAudit({ actorId: user.id, action: 'managed_person.claim', details: { personId: params.id } });
  return { status: 200, body: person };
}));

router.post('/managed-persons/:id/release', requireGroupManager(async ({ params, user }) => {
  if (!UUID_RE.test(params.id) || !(await releasePerson(params.id, user.id))) return { status: 404, body: { error: 'managed person not found' } };
  await logAudit({ actorId: user.id, action: 'managed_person.release', subjectUserId: params.id, details: {} });
  return { status: 200, body: { released: true } };
}));

router.get('/managed-persons/:id', requireAuth(async ({ params, user }) => {
  const person = await getManagedPersonForRegistration(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  return { status: 200, body: person };
}));

router.post('/managed-persons', requireGroupManager(async ({ req, user }) => {
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
    if (charName) await createCharacter(person.id, { name: charName, stub: true });
    return { status: 201, body: person };
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.patch('/managed-persons/:id', requireGroupManager(async ({ req, params, user }) => {
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
