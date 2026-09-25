import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';

const SELECT_COLUMNS = 'id, user_id, class, name, data, created_at';

async function schemaForClass(characterClass) {
  return characterClass === 'nsc' ? getNscProfileSchema() : getScCharacterSchema();
}

export async function createCharacter(userId, { characterClass = 'sc', name, data }) {
  const schema = await schemaForClass(characterClass);
  const errors = validateCharacterData(schema, data ?? {});
  if (errors.length > 0) {
    const err = new Error('invalid character data');
    err.code = 'INVALID_CHARACTER_DATA';
    err.details = errors;
    throw err;
  }
  const { rows } = await query(
    `INSERT INTO characters (user_id, class, name, data)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [userId, characterClass, name, JSON.stringify(data ?? {})]
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
    `SELECT c.id, c.user_id, c.class, c.name, c.data, c.created_at,
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
    `SELECT c.id, c.user_id, c.class, c.name, c.data, c.created_at
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1 AND c.class = 'sc'
     ORDER BY c.name`,
    [eventId]
  );
  return rows;
}

// `isElevated` here means "this caller may write staffOnly fields" -- the
// route deliberately passes `isElevated && !isOwner`, NOT plain group
// permission, because the character's OWNER must never be able to write a
// staffOnly field through their own edit form, regardless of what other
// permissions they happen to hold as a person (e.g. an admin editing their
// own character). Only a genuinely different elevated staff member (e.g.
// via the check-in dialog) may write them.
export async function updateCharacter(id, userId, { name, data }, { isElevated = false } = {}) {
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

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       data = COALESCE($4, data)
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, name ?? null, newData !== undefined ? JSON.stringify(newData) : null]
  );
  return rows[0] ?? null;
}

function characterInUseError() {
  const err = new Error('Charakter ist mit einer Anmeldung verknüpft und kann nicht gelöscht werden.');
  err.code = 'CHARACTER_IN_USE';
  return err;
}

export async function deleteCharacter(id, userId) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  // registrations.character_id/nsc_character_id have no ON DELETE clause
  // (plain REFERENCES, so Postgres defaults to blocking the delete) --
  // ANY referencing row prevents deletion, not just ones in a "locking"
  // status, so this must match that exactly or the DELETE below fails
  // with a raw, unhandled foreign-key-violation error instead of the
  // friendly one. The catch below is a defensive backstop for the same
  // constraint, in case a future caller reaches this path some other way.
  const { rows } = await query('SELECT 1 FROM registrations WHERE character_id = $1 OR nsc_character_id = $1', [id]);
  if (rows.length > 0) {
    throw characterInUseError();
  }

  try {
    await query('DELETE FROM characters WHERE id = $1', [id]);
  } catch (err) {
    if (err.code === '23503') throw characterInUseError();
    throw err;
  }
  return true;
}
