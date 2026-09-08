import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { applyTransition } from './statusMachine.js';
import { displayName } from '../displayName.js';
import { decryptField } from '../crypto/fieldCrypto.js';
import { ENCRYPTED_ACCOUNT_FIELD_COLUMNS } from '../accountFields.js';
import { filterCharacterFields } from '../characters/visibility.js';
import { listOpenInvitationsForEvent } from '../invitations/repository.js';

const SELF_SERVICE_CON_ROLES = ['sc', 'nsc', 'gsc', 'helfer'];
const STAFF_CON_ROLES = ['orga', 'hilfs_orga'];
const ALL_CON_ROLES = [...SELF_SERVICE_CON_ROLES, ...STAFF_CON_ROLES];
// Roles that don't play a character on-site, so approval doesn't require one assigned.
const CHARACTER_EXEMPT_CON_ROLES = [...STAFF_CON_ROLES, 'helfer'];

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

export async function registerForEvent(userId, eventId, conRole, requestingUser) {
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

  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id, con_role)
       VALUES ($1, $2, $3)
       RETURNING user_id, event_id, status, con_role, checked_in_at, checked_out_at`,
      [userId, eventId, conRole]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('already registered for this event');
      dup.code = 'ALREADY_REGISTERED';
      throw dup;
    }
    throw err;
  }
}

export async function setConRole(eventId, userId, conRole, requestingUser) {
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
  const { rows } = await query(
    `UPDATE registrations SET con_role = $3
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, checked_in_at, checked_out_at`,
    [eventId, userId, conRole]
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
    const err = new Error('cannot unregister after check-in');
    err.code = 'CANNOT_UNREGISTER';
    throw err;
  }
}

// `schema` (the event's character_form_schema) and `viewer` (the requesting
// user) gate what gets returned: OT fields are limited to the viewer's own
// group.accountFields (the same rule members.html enforces for editing), and
// character data is filtered through filterCharacterFields — full data only
// for the owner or for canOverrideCheckinStatus staff, public-only otherwise.
export async function listParticipantsForEvent(eventId, { schema = [], viewer } = {}) {
  const otKeys = (viewer?.group?.accountFields ?? []).filter((key) => key in ENCRYPTED_ACCOUNT_FIELD_COLUMNS);
  const otColumnsSql = otKeys.map((key) => `, u.${ENCRYPTED_ACCOUNT_FIELD_COLUMNS[key]}`).join('');

  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.checked_in_at, r.checked_out_at${otColumnsSql}
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
  const { rows: characters } = await query(
    'SELECT id, user_id, name, data FROM characters WHERE event_id = $1',
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

  const registered = registrations.map((r) => ({
    userId: r.user_id,
    invitationId: null,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    status: r.status,
    conRole: r.con_role,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    characters: charactersByUser.get(r.user_id) ?? [],
    otFields: Object.fromEntries(otKeys.map((key) => [key, decryptField(r[ENCRYPTED_ACCOUNT_FIELD_COLUMNS[key]])])),
  }));

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
    'SELECT id, name FROM characters WHERE event_id = $1 AND user_id = $2',
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
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.checked_in_at, r.checked_out_at
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
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
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
  // Only checkin/checkout stamp a timestamp column; approve/cancel touch
  // only `status`. A binary ternary here (as the pre-existing code had)
  // would silently stamp checked_out_at on every non-checkin action once
  // more than two actions exist -- this map makes "no timestamp" explicit.
  const timestampColumn = TIMESTAMP_COLUMNS[action];
  const setClause = timestampColumn ? `status = $4, ${timestampColumn} = now()` : 'status = $4';
  const { rows: updated } = await query(
    `UPDATE registrations SET ${setClause}
     WHERE event_id = $1 AND user_id = $2 AND status = $3
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, currentStatus, nextStatus]
  );
  if (updated.length === 0) {
    const err = new Error('invalid transition: registration status changed concurrently');
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

export async function approveRegistration(eventId, userId) {
  const { rows: regRows } = await query(
    'SELECT con_role FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (regRows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  if (!CHARACTER_EXEMPT_CON_ROLES.includes(regRows[0].con_role)) {
    const { rows: charRows } = await query(
      'SELECT 1 FROM characters WHERE event_id = $1 AND user_id = $2 LIMIT 1',
      [eventId, userId]
    );
    if (charRows.length === 0) {
      const err = new Error('cannot approve: no character assigned for this event');
      err.code = 'NO_CHARACTER';
      throw err;
    }
  }
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
    const err = new Error('status changed concurrently');
    err.code = 'STATUS_CONFLICT';
    throw err;
  }
  return rows[0];
}
