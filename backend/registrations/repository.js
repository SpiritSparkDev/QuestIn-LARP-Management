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
  const { rows } = await query(
    'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
    [userId, eventId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  if (rows[0].status !== 'registered') {
    const err = new Error('cannot unregister after check-in');
    err.code = 'CANNOT_UNREGISTER';
    throw err;
  }
  await query('DELETE FROM registrations WHERE user_id = $1 AND event_id = $2', [userId, eventId]);
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

  const nextStatus = applyTransition(rows[0].status, action);
  const timestampColumn = action === 'checkin' ? 'checked_in_at' : 'checked_out_at';
  const { rows: updated } = await query(
    `UPDATE registrations SET status = $3, ${timestampColumn} = now()
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, nextStatus]
  );
  return updated[0];
}

export async function checkIn(eventId, userId) {
  return transitionStatus(eventId, userId, 'checkin');
}

export async function checkOut(eventId, userId) {
  return transitionStatus(eventId, userId, 'checkout');
}
