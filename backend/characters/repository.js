import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getEvent } from '../events/repository.js';

export async function createCharacter(userId, { eventId, name, data }) {
  const event = await getEvent(eventId);
  if (!event) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  const errors = validateCharacterData(event.character_form_schema, data ?? {});
  if (errors.length > 0) {
    const err = new Error('invalid character data');
    err.code = 'INVALID_CHARACTER_DATA';
    err.details = errors;
    throw err;
  }

  const { rows } = await query(
    `INSERT INTO characters (user_id, event_id, name, data)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, event_id, name, data, created_at`,
    [userId, eventId, name, JSON.stringify(data ?? {})]
  );
  return rows[0];
}

export async function getCharacter(id) {
  const { rows } = await query(
    'SELECT id, user_id, event_id, name, data, created_at FROM characters WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

export async function listCharactersForUser(userId) {
  const { rows } = await query(
    'SELECT id, user_id, event_id, name, data, created_at FROM characters WHERE user_id = $1 ORDER BY created_at',
    [userId]
  );
  return rows;
}

export async function updateCharacter(id, { name, data }) {
  const character = await getCharacter(id);
  if (!character) return null;

  if (data !== undefined) {
    const event = await getEvent(character.event_id);
    const errors = validateCharacterData(event.character_form_schema, data);
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
  }

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($2, name),
       data = COALESCE($3, data)
     WHERE id = $1
     RETURNING id, user_id, event_id, name, data, created_at`,
    [id, name ?? null, data !== undefined ? JSON.stringify(data) : null]
  );
  return rows[0];
}
