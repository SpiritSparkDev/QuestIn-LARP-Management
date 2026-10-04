import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { createCharacter, userExists, getCharacter, listCharactersForUser, listCharactersForEvent, updateCharacter, deleteCharacter } from './repository.js';
import { filterCharacterFields } from './visibility.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { isManagedBy } from '../managedPersons/repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/characters', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { class: characterClass = 'sc', name, data, userId } = body;
  if (characterClass !== 'sc' && characterClass !== 'nsc') {
    return { status: 400, body: { error: 'class must be "sc" or "nsc"' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }

  // Admins and moderators may create a character in someone else's account
  // (userId); for everyone else the character always belongs to the caller.
  let ownerId = user.id;
  if (userId !== undefined && userId !== user.id) {
    if (user.group.key !== 'admin' && user.group.key !== 'moderator') {
      return { status: 403, body: { error: 'forbidden' } };
    }
    if (typeof userId !== 'string' || !UUID_RE.test(userId) || !(await userExists(userId))) {
      return { status: 404, body: { error: 'user not found' } };
    }
    ownerId = userId;
  }

  try {
    const character = await createCharacter(ownerId, { characterClass, name, data });
    return { status: 201, body: character };
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));

router.get('/characters', requireAuth(async ({ user }) => {
  const characters = await listCharactersForUser(user.id);
  return { status: 200, body: characters };
}));

router.get('/events/:eventId/characters/public', requireAuth(async ({ params, user }) => {
  const { characterBrowsingEnabled } = await getAppSettings();
  if (!characterBrowsingEnabled) return { status: 403, body: { error: 'character browsing is disabled' } };
  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const schema = await getScCharacterSchema();
  const characters = await listCharactersForEvent(params.eventId);
  const filtered = characters.map((c) => ({
    id: c.id,
    name: c.name,
    userId: c.user_id,
    data: filterCharacterFields(c, schema, user),
  }));
  return { status: 200, body: filtered };
}));

router.get('/characters/:id', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };

  const isOwner = character.user_id === user.id || await isManagedBy(character.user_id, user.id);
  const isElevated = user.group.canOverrideCheckinStatus;
  if (isOwner || isElevated) {
    return { status: 200, body: character };
  }

  // Both classes now have exactly one, non-event-varying schema (sc's is
  // global as of this change, nsc's already was) -- a stranger viewing by
  // id sees whichever public fields that one schema marks, no per-event
  // ambiguity to fall back from anymore.
  const schema = character.class === 'nsc' ? await getNscProfileSchema() : await getScCharacterSchema();
  return { status: 200, body: { ...character, data: filterCharacterFields(character, schema, user) } };
}));

router.put('/characters/:id', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const isOwner = character.user_id === user.id || await isManagedBy(character.user_id, user.id);
  const isElevated = user.group.canOverrideCheckinStatus;
  if (!isOwner && !isElevated) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    // Staff (canOverrideCheckinStatus) may write staffOnly fields on any
    // character -- including their own. Plain owners never can: the server
    // keeps the stored value for them (see updateCharacter).
    const updated = await updateCharacter(params.id, character.user_id, body, { isElevated });
    return { status: 200, body: updated };
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));

router.delete('/characters/:id', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const isOwner = character.user_id === user.id || await isManagedBy(character.user_id, user.id);
  const isElevated = user.group.canOverrideCheckinStatus;
  if (!isOwner && !isElevated) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  try {
    await deleteCharacter(params.id, character.user_id);
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'CHARACTER_IN_USE') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));
