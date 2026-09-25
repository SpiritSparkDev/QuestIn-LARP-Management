import { query } from '../db.js';
import { sendEventDeletedEmail, getTransporterAndFrom } from '../auth/mailer.js';
import { logger } from '../logger.js';

const SELECT_COLUMNS = 'id, name, event_date, code, capacity, flags, is_active, created_at';

// Trims, drops empty strings, and deduplicates while preserving first-seen
// order -- the admin-facing comma-separated textfield can easily produce
// stray whitespace or repeats, and this is the one place that cleans it up
// before it ever reaches a registration's validation.
function normalizeFlags(flags) {
  if (!Array.isArray(flags)) return [];
  const seen = new Set();
  const result = [];
  for (const f of flags) {
    if (typeof f !== 'string') continue;
    const trimmed = f.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export async function createEvent({ name, eventDate, code, capacity, flags }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code, capacity, flags)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null, capacity ?? null, normalizeFlags(flags)]
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

export async function updateEvent(id, { name, eventDate, code, capacity, clearCapacity, flags }) {
  // code/capacity are the fields a caller can legitimately want to CLEAR
  // (empty string / "unbegrenzt") rather than just omit -- COALESCE alone
  // can't tell those apart, since both arrive as a falsy value. $6/$7
  // carry that distinction explicitly: only skip the write when the field
  // was genuinely absent from the call. flags doesn't need this: an empty
  // array is not falsy in JS, so `flags !== undefined` alone tells omitted
  // apart from explicitly-cleared.
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = CASE WHEN $6 THEN $4 ELSE code END,
       capacity = CASE WHEN $7 THEN $5 ELSE capacity END,
       flags = COALESCE($8, flags)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id, name ?? null, eventDate ?? null, code ?? null, capacity ?? null,
      code !== undefined, capacity !== undefined || Boolean(clearCapacity),
      flags !== undefined ? normalizeFlags(flags) : null,
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

export async function deleteEvent(id, { force = false, notify = false } = {}) {
  const existing = await getEvent(id);
  if (!existing) return false;
  const { rows } = await query('SELECT 1 FROM registrations WHERE event_id = $1 LIMIT 1', [id]);
  if (rows.length > 0 && !force) {
    const err = new Error('Event hat noch Anmeldungen und kann nicht gelöscht werden.');
    err.code = 'EVENT_HAS_REGISTRATIONS';
    throw err;
  }

  let participantEmails = [];
  if (rows.length > 0 && notify) {
    const { rows: emailRows } = await query(
      'SELECT u.email FROM users u JOIN registrations r ON r.user_id = u.id WHERE r.event_id = $1',
      [id]
    );
    participantEmails = emailRows.map((r) => r.email);
  }

  // events.registrations has ON DELETE CASCADE, so removing the event row
  // also removes its registrations (and their payments) in one statement.
  await query('DELETE FROM events WHERE id = $1', [id]);

  if (participantEmails.length > 0) {
    const transport = await getTransporterAndFrom();
    for (const to of participantEmails) {
      try {
        await sendEventDeletedEmail(to, { eventName: existing.name }, transport);
      } catch (err) {
        logger.error('failed to send event-deleted notification', { error: err.message, to, eventId: id });
      }
    }
  }

  return true;
}
