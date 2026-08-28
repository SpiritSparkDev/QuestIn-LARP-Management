import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { applyTransition } from './statusMachine.js';

export async function registerForEvent(userId, eventId) {
  const event = await getEvent(eventId);
  if (!event) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id)
       VALUES ($1, $2)
       RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
      [userId, eventId]
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

export async function unregisterFromEvent(userId, eventId) {
  const { rowCount } = await query(
    "DELETE FROM registrations WHERE user_id = $1 AND event_id = $2 AND status = 'registered'",
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

export async function listParticipantsForEvent(eventId) {
  const { rows: registrations } = await query(
    `SELECT r.user_id, u.name, r.status, r.checked_in_at, r.checked_out_at
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.name`,
    [eventId]
  );
  const { rows: characters } = await query(
    'SELECT id, user_id, name FROM characters WHERE event_id = $1',
    [eventId]
  );

  const charactersByUser = new Map();
  for (const c of characters) {
    if (!charactersByUser.has(c.user_id)) charactersByUser.set(c.user_id, []);
    charactersByUser.get(c.user_id).push({ id: c.id, name: c.name });
  }

  return registrations.map((r) => ({
    userId: r.user_id,
    name: r.name,
    status: r.status,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    characters: charactersByUser.get(r.user_id) ?? [],
  }));
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
  const timestampColumn = action === 'checkin' ? 'checked_in_at' : 'checked_out_at';
  const { rows: updated } = await query(
    `UPDATE registrations SET status = $4, ${timestampColumn} = now()
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

export async function setStatus(eventId, userId, status) {
  const { rows } = await query(
    `UPDATE registrations SET
       status = $3,
       checked_in_at = CASE
         WHEN $3 = 'registered' THEN NULL
         WHEN checked_in_at IS NULL THEN now()
         ELSE checked_in_at
       END,
       checked_out_at = CASE
         WHEN $3 IN ('registered', 'checked_in') THEN NULL
         WHEN checked_out_at IS NULL THEN now()
         ELSE checked_out_at
       END
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, status]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}
