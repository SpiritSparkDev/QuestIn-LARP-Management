import { query } from '../db.js';
import { getEvent } from '../events/repository.js';

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
