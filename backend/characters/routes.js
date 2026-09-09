import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { createCharacter, getCharacter, listCharactersForUser, listCharactersForEvent, updateCharacter } from './repository.js';
import { filterCharacterFields } from './visibility.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';

router.post('/characters', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { class: characterClass = 'sc', name, data } = body;
  if (characterClass !== 'sc' && characterClass !== 'nsc') {
    return { status: 400, body: { error: 'class must be "sc" or "nsc"' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }

  try {
    const character = await createCharacter(user.id, { characterClass, name, data });
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
  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const characters = await listCharactersForEvent(params.eventId);
  const filtered = characters.map((c) => ({
    id: c.id,
    name: c.name,
    userId: c.user_id,
    data: filterCharacterFields(c, event.character_form_schema, user),
  }));
  return { status: 200, body: filtered };
}));

router.get('/characters/:id', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };

  const isOwner = character.user_id === user.id;
  const isElevated = user.group.canOverrideCheckinStatus;
  if (isOwner || isElevated) {
    return { status: 200, body: character };
  }

  // A stranger viewing an sc-class character by id (not through the
  // per-event /events/:eventId/characters/public list) has no single event
  // context to resolve "which schema's public fields" against anymore --
  // an sc character can be registered for many events with different
  // schemas. Default to showing nothing but the name (empty schema means
  // filterCharacterFields' publicKeys set is empty), same safe-default
  // this endpoint already used for the class it doesn't own a schema for.
  const schema = character.class === 'nsc' ? await getNscProfileSchema() : [];
  return { status: 200, body: { ...character, data: filterCharacterFields(character, schema, user) } };
}));

router.put('/characters/:id', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const isOwner = character.user_id === user.id;
  const isElevated = user.group.canOverrideCheckinStatus;
  if (!isOwner && !isElevated) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const updated = await updateCharacter(params.id, character.user_id, body);
    return { status: 200, body: updated };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'EVENT_ID_REQUIRED') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));
