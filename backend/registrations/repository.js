import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { applyTransition } from './statusMachine.js';
import { displayName } from '../displayName.js';
import { decryptFieldBlob as decryptAccountFieldBlob } from '../accountFields.js';
import { filterCharacterFields } from '../characters/visibility.js';
import { listOpenInvitationsForEvent } from '../invitations/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../registrationFields.js';
import { sendRegistrationOtFieldsChangedEmail, getTransporterAndFrom } from '../auth/mailer.js';
import { logger } from '../logger.js';

const SELF_SERVICE_CON_ROLES = ['sc', 'nsc', 'gsc', 'helfer'];
const STAFF_CON_ROLES = ['orga', 'hilfs_orga'];
const ALL_CON_ROLES = [...SELF_SERVICE_CON_ROLES, ...STAFF_CON_ROLES];
// Roles that don't play a character on-site, so approval doesn't require one assigned.
const CHARACTER_EXEMPT_CON_ROLES = [...STAFF_CON_ROLES, 'helfer'];
// Roles whose registration must reference a specific character.
const CHARACTER_REQUIRED_CON_ROLES = ['sc', 'gsc', 'nsc'];

// Orga/Hilfs-Orga may only be granted by someone who is already orga/hilfs_orga
// for THIS SAME event, or who holds system role moderator/admin.
async function canGrantStaffConRole(eventId, requestingUser) {
  if (requestingUser.group.key === 'admin' || requestingUser.group.key === 'moderator') return true;
  const { rows } = await query(
    "SELECT 1 FROM registrations WHERE event_id = $1 AND user_id = $2 AND con_role IN ('orga', 'hilfs_orga')",
    [eventId, requestingUser.id]
  );
  return rows.length > 0;
}

// Validates characterId against con_role: CHARACTER_REQUIRED_CON_ROLES must
// have one that exists, belongs to userId, and has the matching class
// (sc/gsc -> 'sc', nsc -> 'nsc'); every other con_role must NOT have one.
// For an sc-class character, also enforces "at most one registration ever"
// (design spec 2026-09-16, section 4.3) -- excludes the caller's own
// (eventId, userId) row so re-saving an existing registration's con-role
// doesn't flag itself as a conflict. NSC stays exempt: it remains reusable
// across many events, unchanged from before this spec.
// Returns the characterId to store (always null for non-character roles).
async function resolveCharacterId(userId, conRole, characterId, eventId) {
  if (!CHARACTER_REQUIRED_CON_ROLES.includes(conRole)) {
    if (characterId) {
      const err = new Error(`Für die Rolle "${conRole}" darf kein Charakter angegeben werden.`);
      err.code = 'CHARACTER_NOT_ALLOWED';
      throw err;
    }
    return null;
  }
  if (!characterId) {
    const err = new Error(`Für die Rolle "${conRole}" ist ein Charakter erforderlich.`);
    err.code = 'CHARACTER_REQUIRED';
    throw err;
  }
  const { rows } = await query('SELECT user_id, class FROM characters WHERE id = $1', [characterId]);
  if (rows.length === 0) {
    const err = new Error('character not found');
    err.code = 'CHARACTER_NOT_FOUND';
    throw err;
  }
  const character = rows[0];
  if (character.user_id !== userId) {
    const err = new Error('character does not belong to this user');
    err.code = 'CHARACTER_FORBIDDEN';
    throw err;
  }
  const expectedClass = conRole === 'nsc' ? 'nsc' : 'sc';
  if (character.class !== expectedClass) {
    const err = new Error(`Rolle "${conRole}" erfordert einen Charakter der Klasse "${expectedClass}".`);
    err.code = 'CHARACTER_CLASS_MISMATCH';
    throw err;
  }
  if (expectedClass === 'sc') {
    const { rows: existing } = await query(
      'SELECT 1 FROM registrations WHERE character_id = $1 AND NOT (event_id = $2 AND user_id = $3)',
      [characterId, eventId, userId]
    );
    if (existing.length > 0) {
      const err = new Error('Dieser Charakter ist bereits für ein anderes Event angemeldet.');
      err.code = 'CHARACTER_ALREADY_REGISTERED';
      throw err;
    }
  }
  return characterId;
}

export async function registerForEvent(userId, eventId, conRole, characterId, otFields, requestingUser) {
  const event = await getEvent(eventId);
  if (!event) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  if (!ALL_CON_ROLES.includes(conRole)) {
    const err = new Error(`conRole must be one of: ${ALL_CON_ROLES.join(', ')}`);
    err.code = 'INVALID_CON_ROLE';
    throw err;
  }

  if (STAFF_CON_ROLES.includes(conRole) && !(await canGrantStaffConRole(eventId, requestingUser))) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may set this role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }

  // Generalizes the old sc-character-creation active-event gate to every
  // self-service con_role, now that character creation itself has no event
  // context at all to gate on.
  if (SELF_SERVICE_CON_ROLES.includes(conRole) && !requestingUser.group.canEditCharacters && !event.is_active) {
    const err = new Error('Anmeldung ist nur für das aktuell aktive Event möglich.');
    err.code = 'EVENT_NOT_ACTIVE';
    throw err;
  }

  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);

  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id, con_role, character_id, registration_data_enc)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at`,
      [userId, eventId, conRole, resolvedCharacterId, encryptFieldBlob(otFields ?? {})]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('Bereits für dieses Event angemeldet.');
      dup.code = 'ALREADY_REGISTERED';
      throw dup;
    }
    throw err;
  }
}

export async function setConRole(eventId, userId, conRole, characterId, requestingUser) {
  if (!ALL_CON_ROLES.includes(conRole)) {
    const err = new Error(`conRole must be one of: ${ALL_CON_ROLES.join(', ')}`);
    err.code = 'INVALID_CON_ROLE';
    throw err;
  }
  const isOwnRegistration = userId === requestingUser.id;
  const staffGrantOk = await canGrantStaffConRole(eventId, requestingUser);
  if (!isOwnRegistration && !staffGrantOk) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may change another user\'s con_role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }
  if (STAFF_CON_ROLES.includes(conRole) && !staffGrantOk) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may set this role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }

  // con_role can change across the character/no-character boundary (e.g. a
  // helfer promoted to orga keeps character_id NULL; but nothing stops a
  // future caller from also changing a helfer to sc here) -- always resolve
  // characterId the same way registerForEvent does, so this can never write
  // a row that violates registrations_character_con_role_check.
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);

  const { rows } = await query(
    `UPDATE registrations SET con_role = $3, character_id = $4
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at`,
    [eventId, userId, conRole, resolvedCharacterId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}

export async function unregisterFromEvent(userId, eventId) {
  const { rowCount } = await query(
    "DELETE FROM registrations WHERE user_id = $1 AND event_id = $2 AND status = 'pending'",
    [userId, eventId]
  );
  if (rowCount === 0) {
    const { rows } = await query(
      'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );
    if (rows.length === 0) {
      const err = new Error('registration not found');
      err.code = 'REGISTRATION_NOT_FOUND';
      throw err;
    }
    const err = new Error('Abmelden nach Check-In nicht mehr möglich.');
    err.code = 'CANNOT_UNREGISTER';
    throw err;
  }
}

export async function listParticipantsForEvent(eventId, { schema = [], viewer } = {}) {
  const otKeys = (viewer?.group?.accountFields ?? []).filter((key) => key !== 'group');

  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.checked_in_at, r.checked_out_at,
            u.account_data_enc, r.registration_data_enc
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
  const { rows: characters } = await query(
    `SELECT c.id, c.user_id, c.name, c.data
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1`,
    [eventId]
  );

  const charactersByUser = new Map();
  for (const c of characters) {
    if (!charactersByUser.has(c.user_id)) charactersByUser.set(c.user_id, []);
    charactersByUser.get(c.user_id).push({
      id: c.id,
      name: c.name,
      data: filterCharacterFields(c, schema, viewer),
    });
  }

  const registered = registrations.map((r) => {
    const accountData = decryptAccountFieldBlob(r.account_data_enc);
    const registrationData = decryptFieldBlob(r.registration_data_enc);
    const otFields = {};
    for (const key of otKeys) {
      if (key in accountData) otFields[key] = accountData[key];
      else if (key in registrationData) otFields[key] = registrationData[key];
    }
    return {
      userId: r.user_id,
      invitationId: null,
      name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
      status: r.status,
      conRole: r.con_role,
      checkedInAt: r.checked_in_at,
      checkedOutAt: r.checked_out_at,
      characters: charactersByUser.get(r.user_id) ?? [],
      otFields,
    };
  });

  const notified = (await listOpenInvitationsForEvent(eventId)).map((inv) => ({
    userId: null,
    invitationId: inv.invitationId,
    name: inv.name,
    status: 'notified',
    checkedInAt: null,
    checkedOutAt: null,
    characters: [],
    otFields: {},
  }));

  return [...notified, ...registered];
}

export async function getScanLookup(eventId, userId) {
  const { rows } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status, r.con_role
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     JOIN groups g ON g.id = u.group_id
     WHERE r.event_id = $1 AND r.user_id = $2`,
    [eventId, userId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const { rows: characters } = await query(
    `SELECT c.id, c.name
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1 AND r.user_id = $2`,
    [eventId, userId]
  );
  return {
    userId: r.user_id,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    group: r.group_key,
    status: r.status,
    conRole: r.con_role,
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
  };
}

export async function listRegistrationsForUser(userId) {
  const { rows } = await query(
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.checked_in_at, r.checked_out_at,
            r.registration_data_enc
     FROM registrations r
     JOIN events e ON e.id = r.event_id
     WHERE r.user_id = $1
     ORDER BY e.event_date`,
    [userId]
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    eventName: r.event_name,
    eventDate: r.event_date,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    ...decryptFieldBlob(r.registration_data_enc),
  }));
}

const TIMESTAMP_COLUMNS = { checkin: 'checked_in_at', checkout: 'checked_out_at' };

async function transitionStatus(eventId, userId, action) {
  const { rows } = await query(
    'SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }

  const currentStatus = rows[0].status;
  const nextStatus = applyTransition(currentStatus, action);
  const timestampColumn = TIMESTAMP_COLUMNS[action];
  const setClause = timestampColumn ? `status = $4, ${timestampColumn} = now()` : 'status = $4';
  const { rows: updated } = await query(
    `UPDATE registrations SET ${setClause}
     WHERE event_id = $1 AND user_id = $2 AND status = $3
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, currentStatus, nextStatus]
  );
  if (updated.length === 0) {
    const err = new Error('Ungültiger Übergang: Anmeldestatus wurde zwischenzeitlich geändert.');
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
  return updated[0];
}

export async function checkIn(eventId, userId) {
  return transitionStatus(eventId, userId, 'checkin');
}

export async function checkOut(eventId, userId) {
  return transitionStatus(eventId, userId, 'checkout');
}

// The character-existence check from Teil 1 is gone: the
// registrations_character_con_role_check CHECK constraint now guarantees
// every sc/gsc/nsc registration already has a character_id at INSERT time,
// so there's nothing left to verify here.
export async function approveRegistration(eventId, userId) {
  return transitionStatus(eventId, userId, 'approve');
}

export async function cancelRegistration(eventId, userId) {
  return transitionStatus(eventId, userId, 'cancel');
}

export async function setStatus(eventId, userId, status, expectedStatus) {
  const { rows } = await query(
    `UPDATE registrations SET
       status = $4,
       checked_in_at = CASE
         WHEN $4 IN ('pending', 'confirmed', 'cancelled') THEN NULL
         WHEN $4 = 'checked_in' AND checked_in_at IS NULL THEN now()
         ELSE checked_in_at
       END,
       checked_out_at = CASE
         WHEN $4 IN ('pending', 'confirmed', 'cancelled', 'checked_in') THEN NULL
         WHEN checked_out_at IS NULL THEN now()
         ELSE checked_out_at
       END
     WHERE event_id = $1 AND user_id = $2 AND status = $3
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, expectedStatus, status]
  );
  if (rows.length === 0) {
    const { rows: existing } = await query(
      'SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
    if (existing.length === 0) {
      const err = new Error('registration not found');
      err.code = 'REGISTRATION_NOT_FOUND';
      throw err;
    }
    const err = new Error('Status wurde zwischenzeitlich geändert.');
    err.code = 'STATUS_CONFLICT';
    throw err;
  }
  return rows[0];
}

export async function updateRegistrationOtFields(eventId, userId, otFields) {
  const schema = await getRegistrationFieldSchema();
  const { rows: currentRows } = await query(
    'SELECT registration_data_enc FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (currentRows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  const nextData = decryptFieldBlob(currentRows[0].registration_data_enc);
  for (const field of schema) {
    if (otFields[field.key] !== undefined) nextData[field.key] = otFields[field.key];
  }

  const { rows } = await query(
    `UPDATE registrations SET registration_data_enc = $3
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at, registration_data_enc`,
    [eventId, userId, encryptFieldBlob(nextData)]
  );
  const r = rows[0];
  return {
    userId: r.user_id,
    eventId: r.event_id,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    ...decryptFieldBlob(r.registration_data_enc),
  };
}

// Recipients for the "a registration's OT fields changed" notification:
// every user holding an orga/hilfs_orga registration for THIS event, plus
// every system admin/moderator, regardless of event. A plain UNION (not a
// JOIN + OR) so each half stays simple to read and test independently.
export async function resolveOtFieldsChangeRecipients(eventId) {
  const { rows } = await query(
    `SELECT email FROM (
       SELECT u.email FROM users u
       JOIN registrations r ON r.user_id = u.id
       WHERE r.event_id = $1 AND r.con_role IN ('orga', 'hilfs_orga')
       UNION
       SELECT u.email FROM users u
       JOIN groups g ON g.id = u.group_id
       WHERE g.key IN ('admin', 'moderator')
     ) recipients`,
    [eventId]
  );
  return rows.map((r) => r.email);
}

// Never throws -- a delivery failure to one or all recipients must not turn
// a successful field save into a 500. Each recipient gets its own
// try/catch so one bad address doesn't stop the rest.
export async function notifyRegistrationOtFieldsChanged(eventId, userId) {
  try {
    const event = await getEvent(eventId);
    const { rows: userRows } = await query(
      'SELECT first_name, last_name, nickname FROM users WHERE id = $1',
      [userId]
    );
    const userName = userRows[0]
      ? displayName({ firstName: userRows[0].first_name, lastName: userRows[0].last_name, nickname: userRows[0].nickname })
      : 'Unbekannt';
    const eventName = event?.name ?? 'Unbekanntes Event';
    const recipients = await resolveOtFieldsChangeRecipients(eventId);
    // Build one transporter/from pair for the whole recipient loop instead of
    // per-recipient -- getTransporterAndFrom() re-reads SMTP settings and
    // opens a fresh nodemailer connection each time it's called, which would
    // otherwise serialize into N connect/greet/socket-timeout waits.
    const transport = await getTransporterAndFrom();
    for (const to of recipients) {
      try {
        await sendRegistrationOtFieldsChangedEmail(to, { userName, eventName }, transport);
      } catch (err) {
        logger.error('failed to send OT-fields-changed notification', { error: err.message, to, eventId, userId });
      }
    }
  } catch (err) {
    logger.error('failed to prepare OT-fields-changed notification', { error: err.message, eventId, userId });
  }
}
