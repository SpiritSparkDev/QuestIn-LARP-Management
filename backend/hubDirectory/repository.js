import { query } from '../db.js';

const today = () => new Date().toISOString().slice(0, 10);

// Events listed in the public directory feed: explicitly published, no test
// data, not ended, not over yet. Independent of is_active (only one event per
// instance is active at a time, but several can be announced).
export async function listPublishedEvents(day = today()) {
  const { rows } = await query(
    `SELECT id, name, event_date, end_date, color FROM events
     WHERE directory_published AND NOT is_test AND ended_at IS NULL
       AND COALESCE(end_date, event_date) >= $1::date
     ORDER BY event_date, name`,
    [day]
  );
  return rows;
}

export async function getDirectoryCache() {
  const { rows } = await query('SELECT events, fetched_at, last_success_at, last_error FROM hub_directory_cache WHERE id');
  return rows[0] ?? { events: [], fetched_at: null, last_success_at: null, last_error: null };
}

export async function saveDirectorySuccess(events) {
  await query(
    `INSERT INTO hub_directory_cache (id, events, fetched_at, last_success_at, last_error) VALUES (true, $1, now(), now(), NULL)
     ON CONFLICT (id) DO UPDATE SET events = EXCLUDED.events, fetched_at = now(), last_success_at = now(), last_error = NULL`,
    [JSON.stringify(events)]
  );
}

export async function saveDirectoryError(message) {
  await query(
    `INSERT INTO hub_directory_cache (id, fetched_at, last_error) VALUES (true, now(), $1)
     ON CONFLICT (id) DO UPDATE SET fetched_at = now(), last_error = EXCLUDED.last_error`,
    [message]
  );
}
