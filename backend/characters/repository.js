import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';

const SELECT_COLUMNS = 'id, user_id, class, name, data, is_gsc, created_at';
const CHARACTER_LOCKING_STATUSES = ['confirmed', 'checked_in', 'checked_out'];

async function schemaForClass(characterClass) {
  return characterClass === 'nsc' ? getNscProfileSchema() : getScCharacterSchema();
}

export async function createCharacter(userId, { characterClass = 'sc', name, data, isGsc = false }) {
  const schema = await schemaForClass(characterClass);
  const errors = validateCharacterData(schema, data ?? {});
  if (errors.length > 0) {
    const err = new Error('invalid character data');
    err.code = 'INVALID_CHARACTER_DATA';
    err.details = errors;
    throw err;
  }
  // isGsc is a system flag meaningful only for SC characters -- silently
  // dropped for nsc rather than rejected, so the frontend never needs a
  // conditional check before sending it.
  const gscFlag = characterClass === 'sc' && Boolean(isGsc);
  const { rows } = await query(
    `INSERT INTO characters (user_id, class, name, data, is_gsc)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [userId, characterClass, name, JSON.stringify(data ?? {}), gscFlag]
  );
  return rows[0];
}

export async function getCharacter(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM characters WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Each sc-class row gets at most one registrations match (enforced at the
// application level in registrations/repository.js's resolveCharacterId,
// not a DB constraint -- see the design spec section 4.3) -- the LATERAL
// join only runs for class='sc' rows, so an nsc-class character (still
// reusable across many registrations) is never multiplied into duplicate
// list entries.
export async function listCharactersForUser(userId) {
  const { rows } = await query(
    `SELECT c.id, c.user_id, c.class, c.name, c.data, c.is_gsc, c.created_at,
            reg.event_id AS registered_event_id, reg.con_role AS registered_con_role,
            ev.name AS registered_event_name
     FROM characters c
     LEFT JOIN LATERAL (
       SELECT r.event_id, r.con_role
       FROM registrations r
       WHERE r.character_id = c.id
       ORDER BY r.event_id
       LIMIT 1
     ) reg ON c.class = 'sc'
     LEFT JOIN events ev ON ev.id = reg.event_id
     WHERE c.user_id = $1
     ORDER BY c.created_at`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    class: row.class,
    name: row.name,
    data: row.data,
    is_gsc: row.is_gsc,
    created_at: row.created_at,
    registeredFor: row.registered_event_id
      ? { eventId: row.registered_event_id, eventName: row.registered_event_name, conRole: row.registered_con_role }
      : null,
  }));
}

// Characters registered for a given event, found via the registration link
// (not a direct column -- see design spec section 4.3).
export async function listCharactersForEvent(eventId) {
  const { rows } = await query(
    `SELECT c.id, c.user_id, c.class, c.name, c.data, c.is_gsc, c.created_at
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1 AND c.class = 'sc'
     ORDER BY c.name`,
    [eventId]
  );
  return rows;
}

export async function updateCharacter(id, userId, { name, data, isGsc }, { isElevated = false } = {}) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  let newData;
  if (data !== undefined) {
    const schema = await schemaForClass(character.class);
    // A staffOnly field's value can never be changed by the owner
    // themselves -- their own edit form doesn't even render an input for
    // it (a disabled input never reaches FormData), so trust the SERVER's
    // existing value here rather than whatever the client happened to
    // send, regardless of type or emptiness.
    const effectiveData = isElevated ? data : { ...data };
    if (!isElevated) {
      for (const field of schema) {
        if (field.staffOnly) effectiveData[field.key] = character.data?.[field.key];
      }
    }
    const errors = validateCharacterData(schema, effectiveData);
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
    newData = effectiveData;
  }

  // Same "sc only" rule as createCharacter; NULL (not false) means "don't
  // touch is_gsc" so COALESCE below preserves the existing value.
  const gscFlag = isGsc !== undefined && character.class === 'sc' ? Boolean(isGsc) : null;

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       data = COALESCE($4, data),
       is_gsc = COALESCE($5, is_gsc)
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, name ?? null, newData !== undefined ? JSON.stringify(newData) : null, gscFlag]
  );
  return rows[0] ?? null;
}

export async function deleteCharacter(id, userId) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  const { rows } = await query('SELECT status FROM registrations WHERE character_id = $1 OR nsc_character_id = $1', [id]);
  if (rows.some((r) => CHARACTER_LOCKING_STATUSES.includes(r.status))) {
    const err = new Error('Charakter ist mit einer bestätigten Anmeldung verknüpft und kann nicht gelöscht werden.');
    err.code = 'CHARACTER_IN_USE';
    throw err;
  }

  await query('DELETE FROM characters WHERE id = $1', [id]);
  return true;
}
