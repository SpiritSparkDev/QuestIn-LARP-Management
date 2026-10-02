import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getManagedPerson } from './repository.js';
import { createCharacter, listCharactersForUser } from '../characters/repository.js';

router.get('/managed-persons/:id/characters', requireAuth(async ({ params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  const characters = await listCharactersForUser(person.id);
  return { status: 200, body: characters };
}));

router.post('/managed-persons/:id/characters', requireAuth(async ({ req, params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };

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
    const character = await createCharacter(person.id, { characterClass, name, data });
    return { status: 201, body: character };
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));
