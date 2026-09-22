import { query } from '../db.js';

const SELECT_COLUMNS = 'id, name, event_date, code, capacity, is_active, created_at';

export async function createEvent({ name, eventDate, code, capacity }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code, capacity)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null, capacity ?? null]
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

export async function updateEvent(id, { name, eventDate, code, capacity, clearCapacity }) {
  // code/capacity are the fields a caller can legitimately want to CLEAR
  // (empty string / "unbegrenzt") rather than just omit -- COALESCE alone
  // can't tell those apart, since both arrive as a falsy value. $6/$7
  // carry that distinction explicitly: only skip the write when the field
  // was genuinely absent from the call.
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = CASE WHEN $6 THEN $4 ELSE code END,
       capacity = CASE WHEN $7 THEN $5 ELSE capacity END
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, name ?? null, eventDate ?? null, code ?? null, capacity ?? null, code !== undefined, capacity !== undefined || Boolean(clearCapacity)]
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

export async function deleteEvent(id) {
  const existing = await getEvent(id);
  if (!existing) return false;
  const { rows } = await query('SELECT 1 FROM registrations WHERE event_id = $1 LIMIT 1', [id]);
  if (rows.length > 0) {
    const err = new Error('Event hat noch Anmeldungen und kann nicht gelöscht werden.');
    err.code = 'EVENT_HAS_REGISTRATIONS';
    throw err;
  }
  await query('DELETE FROM events WHERE id = $1', [id]);
  return true;
}
