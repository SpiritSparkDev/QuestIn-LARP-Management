import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { logger } from '../logger.js';
import { sendCharacterDeletedOrgaEmail, getTransporterAndFrom } from '../auth/mailer.js';
import { resolveOtFieldsChangeRecipients, maybePromoteFromWaitlist } from '../registrations/repository.js';
import { logAudit } from '../audit/repository.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { sanitizeDocumentFields } from '../richText.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';

const SELECT_COLUMNS = 'id, user_id, name, data, nsc_data, created_at';

// `stub`: a placeholder character (name only) that is filled in later, so required fields aren't enforced yet.
export async function createCharacter(userId, { name, data, stub = false }) {
  const schema = await getScCharacterSchema();
  data = sanitizeDocumentFields(schema, data ?? {});
  const errors = stub ? [] : validateCharacterData(schema, data);
  if (errors.length > 0) {
    const err = new Error('invalid character data');
    err.code = 'INVALID_CHARACTER_DATA';
    err.details = errors;
    throw err;
  }
  const { rows } = await query(
    `INSERT INTO characters (user_id, name, data)
     VALUES ($1, $2, $3)
     RETURNING ${SELECT_COLUMNS}`,
    [userId, name, JSON.stringify(data ?? {})]
  );
  return rows[0];
}

export async function userExists(id) {
  const { rows } = await query('SELECT 1 FROM users WHERE id = $1', [id]);
  return rows.length > 0;
}

export async function getCharacter(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM characters WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Each character gets at most one registrations match (LATERAL ... LIMIT 1), so a
// character reused across many registrations is never duplicated in the list.
export async function listCharactersForUser(userId) {
  const { rows } = await query(
    `SELECT c.id, c.user_id, c.name, c.data, c.nsc_data, c.created_at,
            reg.event_id AS registered_event_id, reg.con_role AS registered_con_role,
            ev.name AS registered_event_name
     FROM characters c
     LEFT JOIN LATERAL (
       SELECT r.event_id, r.con_role
       FROM registrations r
       WHERE r.character_id = c.id
       ORDER BY r.event_id
       LIMIT 1
     ) reg ON true
     LEFT JOIN events ev ON ev.id = reg.event_id
     WHERE c.user_id = $1
     ORDER BY c.created_at`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    data: row.data,
    nscData: row.nsc_data,
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
    `SELECT c.id, c.user_id, c.name, c.data, c.created_at
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1
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
export async function updateCharacter(id, userId, { name, data }, { isElevated = false, actorId = null, groupFieldsOnly = false, nsc = false } = {}) {
  // `nsc`: edit the NSC questionnaire values (nsc_data, NSC schema) instead of the character sheet.
  const column = nsc ? 'nsc_data' : 'data';
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  let newData;
  let staffFieldChanges = [];
  let groupFieldChanges = [];
  if (data !== undefined) {
    const schema = nsc ? await getNscProfileSchema() : await getScCharacterSchema();
    const stored = character[column] ?? {};
    // A staffOnly field's value can never be changed by the owner
    // themselves -- their own edit form doesn't even render an input for
    // it (a disabled input never reaches FormData), so trust the SERVER's
    // existing value here rather than whatever the client happened to
    // send, regardless of type or emptiness.
    // A group manager above the owner only writes the fields marked
    // "Gruppenverwaltung" in the schema; everything else keeps its stored value.
    let source = data;
    if (groupFieldsOnly) {
      source = { ...stored };
      for (const field of schema) {
        if (field.groupManaged && data && field.key in data) source[field.key] = data[field.key];
      }
    }
    const effectiveData = sanitizeDocumentFields(schema, isElevated ? source : { ...source });
    if (!isElevated) {
      for (const field of schema) {
        if (field.staffOnly) effectiveData[field.key] = stored[field.key];
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
    if (groupFieldsOnly) {
      groupFieldChanges = schema
        .filter((field) => field.groupManaged)
        .map((field) => ({ field: field.key, label: field.label ?? field.key, from: stored[field.key] ?? null, to: effectiveData[field.key] ?? null }))
        .filter((change) => JSON.stringify(change.from) !== JSON.stringify(change.to));
    }
    // Every change to a staffOnly field made by staff is logged (field, old and new value).
    if (isElevated) {
      staffFieldChanges = schema
        .filter((field) => field.staffOnly)
        .map((field) => ({ field: field.key, label: field.label ?? field.key, from: stored[field.key] ?? null, to: effectiveData[field.key] ?? null }))
        .filter((change) => JSON.stringify(change.from) !== JSON.stringify(change.to));
    }
  }

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       ${column} = COALESCE($4, ${column})
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, groupFieldsOnly ? null : (name ?? null), newData !== undefined ? JSON.stringify(newData) : null]
  );
  if (rows[0]) {
    for (const change of groupFieldChanges) {
      await logAudit({
        actorId,
        action: 'character.group_field_changed',
        subjectUserId: userId,
        details: { characterId: id, characterName: rows[0].name, ...change },
      });
    }
    for (const change of staffFieldChanges) {
      await logAudit({
        actorId,
        action: 'character.staff_field_changed',
        subjectUserId: userId,
        details: { characterId: id, characterName: rows[0].name, ...change },
      });
    }
  }
  return rows[0] ?? null;
}

// Registrations that reference the character as their sc character (those
// are lost with it) or as their optional nsc character (only the link goes).
export async function listCharacterRegistrations(id) {
  const { rows } = await query(
    `SELECT r.user_id, r.event_id, e.name AS event_name, r.status, r.con_role,
            r.paid_at, r.amount_due_cents, (r.character_id = $1) AS is_sc_link,
            u.first_name, u.last_name, u.nickname
     FROM registrations r
     JOIN events e ON e.id = r.event_id
     JOIN users u ON u.id = r.user_id
     WHERE r.character_id = $1 OR r.nsc_character_id = $1
     ORDER BY e.event_date, e.name`,
    [id]
  );
  return rows.map((r) => ({
    userId: r.user_id,
    eventId: r.event_id,
    eventName: r.event_name,
    status: r.status,
    conRole: r.con_role,
    paid: r.paid_at !== null,
    amountDueCents: r.amount_due_cents,
    participationLost: r.is_sc_link,
    userName: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
  }));
}

function characterInUseError(registrations) {
  const err = new Error('Charakter ist mit einer Event-Anmeldung verknüpft.');
  err.code = 'CHARACTER_IN_USE';
  err.registrations = registrations;
  return err;
}

// Without `force`, a character that is part of a registration is not deleted
// -- the error carries the affected registrations so the UI can warn first.
// With `force`, the registrations that need the character (sc link) are
// removed with it, the optional nsc link is just cleared, and the orga is
// notified so they can arrange cancellation/refunds.
export async function deleteCharacter(id, userId, { force = false, actorId = null } = {}) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  const registrations = await listCharacterRegistrations(id);
  if (registrations.length > 0 && !force) {
    throw characterInUseError(registrations);
  }

  const lost = registrations.filter((r) => r.participationLost);
  await withTransaction(async (client) => {
    await client.query('DELETE FROM registrations WHERE character_id = $1', [id]);
    await client.query('UPDATE registrations SET nsc_character_id = NULL WHERE nsc_character_id = $1', [id]);
    await client.query('DELETE FROM characters WHERE id = $1', [id]);
  });

  if (registrations.length > 0) {
    await logAudit({
      actorId,
      action: 'character.deleted_with_registrations',
      subjectUserId: userId,
      details: { characterId: id, characterName: character.name, registrations: registrations.map((r) => ({ eventId: r.eventId, eventName: r.eventName, status: r.status, paid: r.paid, participationLost: r.participationLost })) },
    });
    await notifyCharacterDeleted(character, registrations);
    for (const eventId of new Set(lost.map((r) => r.eventId))) {
      await maybePromoteFromWaitlist(eventId);
    }
  }
  return true;
}

// Never throws -- the deletion already happened.
async function notifyCharacterDeleted(character, registrations) {
  try {
    const transport = await getTransporterAndFrom();
    for (const reg of registrations) {
      const recipients = await resolveOtFieldsChangeRecipients(reg.eventId);
      for (const to of recipients) {
        try {
          await sendCharacterDeletedOrgaEmail(to, {
            userName: reg.userName,
            characterName: character.name,
            eventName: reg.eventName,
            participationLost: reg.participationLost,
            paid: reg.paid,
          }, transport);
        } catch (err) {
          logger.error('failed to send character-deleted notification', { error: err.message, to, eventId: reg.eventId });
        }
      }
    }
  } catch (err) {
    logger.error('failed to prepare character-deleted notification', { error: err.message, characterId: character.id });
  }
}
