import { query } from '../db.js';

const SELECT_COLUMNS = 'id, name, event_date, code, character_form_schema, is_active, created_at';

export async function createEvent({ name, eventDate, code, characterFormSchema }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code, character_form_schema)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null, JSON.stringify(characterFormSchema ?? [])]
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

export async function updateEvent(id, { name, eventDate, code, characterFormSchema }) {
  // code is the one optional field a caller can legitimately want to CLEAR
  // (an empty string from a form), not just omit -- COALESCE alone can't
  // tell those apart, since both arrive as a falsy value bound to $4. $6
  // carries that distinction explicitly: only skip the write when the
  // field was genuinely absent from the call.
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = CASE WHEN $6 THEN $4 ELSE code END,
       character_form_schema = COALESCE($5, character_form_schema)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      name ?? null,
      eventDate ?? null,
      code ?? null,
      characterFormSchema !== undefined ? JSON.stringify(characterFormSchema) : null,
      code !== undefined,
    ]
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
