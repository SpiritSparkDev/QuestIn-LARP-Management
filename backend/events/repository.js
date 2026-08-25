import { query } from '../db.js';

export async function createEvent({ name, eventDate, characterFormSchema }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, character_form_schema)
     VALUES ($1, $2, $3)
     RETURNING id, name, event_date, character_form_schema, created_at`,
    [name, eventDate, JSON.stringify(characterFormSchema ?? [])]
  );
  return rows[0];
}

export async function getEvent(id) {
  const { rows } = await query(
    'SELECT id, name, event_date, character_form_schema, created_at FROM events WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

export async function listEvents() {
  const { rows } = await query(
    'SELECT id, name, event_date, character_form_schema, created_at FROM events ORDER BY event_date'
  );
  return rows;
}

export async function updateEvent(id, { name, eventDate, characterFormSchema }) {
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       character_form_schema = COALESCE($4, character_form_schema)
     WHERE id = $1
     RETURNING id, name, event_date, character_form_schema, created_at`,
    [
      id,
      name ?? null,
      eventDate ?? null,
      characterFormSchema !== undefined ? JSON.stringify(characterFormSchema) : null,
    ]
  );
  return rows[0] ?? null;
}
