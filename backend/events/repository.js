import { query } from '../db.js';

const SELECT_COLUMNS = 'id, name, event_date, code, is_active, created_at';

export async function createEvent({ name, eventDate, code }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code)
     VALUES ($1, $2, $3)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null]
  );
  return rows[0];
}

export async function getEvent(id) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM events WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listEvents() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM events ORDER BY event_date`
  );
  return rows;
}

export async function updateEvent(id, { name, eventDate, code }) {
  // code is the one optional field a caller can legitimately want to CLEAR
  // (an empty string from a form), not just omit -- COALESCE alone can't
  // tell those apart, since both arrive as a falsy value bound to $4. $5
  // carries that distinction explicitly: only skip the write when the
  // field was genuinely absent from the call.
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = CASE WHEN $5 THEN $4 ELSE code END
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, name ?? null, eventDate ?? null, code ?? null, code !== undefined]
  );
  return rows[0] ?? null;
}

// At most one event is ever active: this unconditionally sets every row's
// is_active based on whether it matches id, in one statement, so the
// invariant holds after every call with no separate "deactivate the rest"
// step to keep in sync.
export async function activateEvent(id) {
  const existing = await getEvent(id);
  if (!existing) return null;
  await query('UPDATE events SET is_active = (id = $1)', [id]);
  return getEvent(id);
}
