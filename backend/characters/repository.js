import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getEvent } from '../events/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';

const SELECT_COLUMNS = 'id, user_id, class, name, data, created_at';

export async function createCharacter(userId, { characterClass, name, data }) {
  if (characterClass === 'nsc') {
    const schema = await getNscProfileSchema();
    const errors = validateCharacterData(schema, data ?? {});
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
    const { rows } = await query(
      `INSERT INTO characters (user_id, class, name, data)
       VALUES ($1, 'nsc', $2, $3)
       RETURNING ${SELECT_COLUMNS}`,
      [userId, name, JSON.stringify(data ?? {})]
    );
    return rows[0];
  }

  const { rows } = await query(
    `INSERT INTO characters (user_id, class, name, data)
     VALUES ($1, 'sc', $2, '{}')
     RETURNING ${SELECT_COLUMNS}`,
    [userId, name]
  );
  return rows[0];
}

export async function getCharacter(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM characters WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listCharactersForUser(userId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM characters WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  return rows;
}

// Characters registered for a given event, found via the registration link
// (not a direct column anymore — a character can be registered for many
// events, so "its" event only exists in the context of one registration).
export async function listCharactersForEvent(eventId) {
  const { rows } = await query(
    `SELECT c.id, c.user_id, c.class, c.name, c.data, c.created_at
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1 AND c.class = 'sc'
     ORDER BY c.name`,
    [eventId]
  );
  return rows;
}

export async function updateCharacter(id, userId, { name, data, eventId }) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  let mergedData;
  if (data !== undefined) {
    if (character.class === 'nsc') {
      const schema = await getNscProfileSchema();
      const errors = validateCharacterData(schema, data);
      if (errors.length > 0) {
        const err = new Error('invalid character data');
        err.code = 'INVALID_CHARACTER_DATA';
        err.details = errors;
        throw err;
      }
      mergedData = data;
    } else {
      if (!eventId) {
        const err = new Error('eventId is required when updating data for an sc-class character');
        err.code = 'EVENT_ID_REQUIRED';
        throw err;
      }
      const event = await getEvent(eventId);
      if (!event) {
        const err = new Error('event not found');
        err.code = 'EVENT_NOT_FOUND';
        throw err;
      }
      // The submitted `data` is validated as a complete fragment against
      // THIS event's schema (must contain exactly this schema's fields,
      // validateCharacterData rejects unknown keys) -- then merged into the
      // character's existing data so fields from other events' schemas
      // survive, instead of being wiped by a full replace.
      const errors = validateCharacterData(event.character_form_schema, data);
      if (errors.length > 0) {
        const err = new Error('invalid character data');
        err.code = 'INVALID_CHARACTER_DATA';
        err.details = errors;
        throw err;
      }
      mergedData = { ...character.data, ...data };
    }
  }

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       data = COALESCE($4, data)
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, name ?? null, mergedData !== undefined ? JSON.stringify(mergedData) : null]
  );
  return rows[0] ?? null;
}
