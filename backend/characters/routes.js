import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { createCharacter, getCharacter, listCharactersForUser, updateCharacter } from './repository.js';

router.post('/characters', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { class: characterClass = 'sc', eventId, name, data } = body;
  if (characterClass !== 'sc' && characterClass !== 'nsc') {
    return { status: 400, body: { error: 'class must be "sc" or "nsc"' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }
  if (!user.group.characterClasses.includes(characterClass)) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  if (characterClass === 'sc') {
    if (!eventId) return { status: 400, body: { error: 'eventId is required' } };
    if (!user.group.canEditCharacters) {
      const event = await getEvent(eventId);
      if (!event) return { status: 404, body: { error: 'event not found' } };
      if (!event.is_active) {
        return { status: 403, body: { error: 'characters can only be created for the currently active event' } };
      }
    }
  } else if (eventId) {
    return { status: 400, body: { error: 'eventId must not be set for nsc-class characters' } };
  }

  try {
    const character = await createCharacter(user.id, { characterClass, eventId, name, data });
    return { status: 201, body: character };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
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

router.get('/characters/:id', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  if (character.user_id !== user.id && !user.group.canEditCharacters) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  return { status: 200, body: character };
}));

router.put('/characters/:id', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  if (character.user_id !== user.id) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const updated = await updateCharacter(params.id, user.id, body);
    return { status: 200, body: updated };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));
