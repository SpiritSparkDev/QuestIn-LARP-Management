import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { createCharacter, userExists, getCharacter, listCharactersForUser, listCharactersForEvent, updateCharacter, deleteCharacter } from './repository.js';
import { filterCharacterFields } from './visibility.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { isGroupAncestorOf } from '../groupTree/repository.js';
import { isManagedBy } from '../managedPersons/repository.js';
import { logAudit } from '../audit/repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/characters', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, data, userId } = body;
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
    const character = await createCharacter(ownerId, { name, data });
    await logAudit({ actorId: user.id, action: 'character.created', subjectUserId: ownerId, details: { characterName: name } });
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

  // nsc_data is never public.
  const schema = await getScCharacterSchema();
  const { nsc_data: _nscData, ...publicCharacter } = character;
  return { status: 200, body: { ...publicCharacter, data: filterCharacterFields(character, schema, user) } };
}));

// `nsc`: same permission/validation path, but for the NSC questionnaire values (nsc_data).
const putCharacter = (nsc) => requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const isOwner = character.user_id === user.id || await isManagedBy(character.user_id, user.id);
  const isElevated = user.group.canOverrideCheckinStatus;
  const isGroupAncestor = !isOwner && !isElevated && await isGroupAncestorOf(user.id, character.user_id);
  if (!isOwner && !isElevated && !isGroupAncestor) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    // Staff (canOverrideCheckinStatus) may write staffOnly fields on any
    // character -- including their own. Plain owners never can: the server
    // keeps the stored value for them (see updateCharacter).
    const updated = await updateCharacter(params.id, character.user_id, nsc ? { data: body.data ?? {} } : body, { isElevated, actorId: user.id, groupFieldsOnly: isGroupAncestor, nsc });
    return { status: 200, body: updated };
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
});

router.put('/characters/:id', putCharacter(false));
router.put('/characters/:id/nsc-data', putCharacter(true));

router.delete('/characters/:id', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const isOwner = character.user_id === user.id || await isManagedBy(character.user_id, user.id);
  const isElevated = user.group.canOverrideCheckinStatus;
  if (!isOwner && !isElevated) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  try {
    const force = new URL(req.url, 'http://localhost').searchParams.get('force') === 'true';
    await deleteCharacter(params.id, character.user_id, { force, actorId: user.id });
    await logAudit({ actorId: user.id, action: 'character.deleted', subjectUserId: character.user_id, details: { characterName: character.name, forced: force } });
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'CHARACTER_IN_USE') {
      return { status: 409, body: { error: err.message, code: 'CHARACTER_IN_USE', registrations: err.registrations } };
    }
    throw err;
  }
}));
