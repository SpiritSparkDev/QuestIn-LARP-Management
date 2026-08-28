import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getEvent } from '../events/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';

const SELECT_COLUMNS = 'id, user_id, event_id, class, name, data, created_at';

export async function createCharacter(userId, { characterClass, eventId, name, data }) {
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
      `INSERT INTO characters (user_id, event_id, class, name, data)
       VALUES ($1, NULL, 'nsc', $2, $3)
       RETURNING ${SELECT_COLUMNS}`,
      [userId, name, JSON.stringify(data ?? {})]
    );
    return rows[0];
  }

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
    `INSERT INTO characters (user_id, event_id, class, name, data)
     VALUES ($1, $2, 'sc', $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [userId, eventId, name, JSON.stringify(data ?? {})]
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

export async function updateCharacter(id, userId, { name, data }) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  if (data !== undefined) {
    let schema;
    if (character.class === 'nsc') {
      schema = await getNscProfileSchema();
    } else {
      const event = await getEvent(character.event_id);
      if (!event) {
        const err = new Error('event not found');
        err.code = 'EVENT_NOT_FOUND';
        throw err;
      }
      schema = event.character_form_schema;
    }
    const errors = validateCharacterData(schema, data);
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
  }

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       data = COALESCE($4, data)
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, name ?? null, data !== undefined ? JSON.stringify(data) : null]
  );
  return rows[0] ?? null;
}
