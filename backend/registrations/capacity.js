// Participant limits of an event: a total limit and one each for SC and NSC. Which con roles count at all
// is an admin setting (app_settings.capacity_counted_roles), by default SC, NSC and direct registrations (ticket);
// crew roles (helfer, hilfs_orga, orga) do not count. A registration counts while it is in a COUNTED status.
export const COUNTED_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out'];
export const ALL_CON_ROLES = ['sc', 'nsc', 'ticket', 'helfer', 'hilfs_orga', 'orga'];
export const DEFAULT_COUNTED_ROLES = ['sc', 'nsc', 'ticket'];

// `run(sql, params)` is `query` or a transaction client's query -- so the caller decides about locking.
export async function getCountedRoles(run) {
  const { rows } = await run('SELECT capacity_counted_roles FROM app_settings LIMIT 1', []);
  return rows[0]?.capacity_counted_roles ?? DEFAULT_COUNTED_ROLES;
}

// Limits (hard limit if set, else the planned places; null = unlimited) and current counts.
// With `lockEvent` the event row is locked, so two registrations cannot both take the last place.
export async function loadCapacity(run, eventId, { lockEvent = false } = {}) {
  const { rows: eventRows } = await run(
    `SELECT COALESCE(hard_capacity, capacity) AS total, COALESCE(sc_hard_capacity, sc_capacity) AS sc,
            COALESCE(nsc_hard_capacity, nsc_capacity) AS nsc
     FROM events WHERE id = $1${lockEvent ? ' FOR UPDATE' : ''}`,
    [eventId]
  );
  const limits = { total: eventRows[0]?.total ?? null, sc: eventRows[0]?.sc ?? null, nsc: eventRows[0]?.nsc ?? null };
  const roles = await getCountedRoles(run);
  const { rows } = await run(
    `SELECT con_role, count(*)::int AS n FROM registrations
     WHERE event_id = $1 AND status = ANY($2::text[]) AND con_role = ANY($3::text[]) GROUP BY con_role`,
    [eventId, COUNTED_STATUSES, roles]
  );
  const counts = { total: 0, sc: 0, nsc: 0 };
  for (const row of rows) {
    counts.total += row.n;
    if (row.con_role === 'sc') counts.sc = row.n;
    if (row.con_role === 'nsc') counts.nsc = row.n;
  }
  return { limits, counts, roles: new Set(roles) };
}

// Which limit stops a registration of `role`: 'total', 'sc', 'nsc', or null if it fits (or the role is not counted).
export function capacityBlock(state, role) {
  if (!state.roles.has(role)) return null;
  if (state.limits.total !== null && state.counts.total >= state.limits.total) return 'total';
  if ((role === 'sc' || role === 'nsc') && state.limits[role] !== null && state.counts[role] >= state.limits[role]) return role;
  return null;
}

// The state after a counted registration of `role` is added (for promoting several people in one pass).
export function withAdded(state, role) {
  if (!state.roles.has(role)) return state;
  const counts = { ...state.counts, total: state.counts.total + 1 };
  if (role === 'sc' || role === 'nsc') counts[role] += 1;
  return { ...state, counts };
}

// The state without one existing counted registration (for checking a role change of that very registration).
export function withRemoved(state, role) {
  if (!state.roles.has(role)) return state;
  const counts = { ...state.counts, total: state.counts.total - 1 };
  if (role === 'sc' || role === 'nsc') counts[role] -= 1;
  return { ...state, counts };
}

export const BLOCK_MESSAGES = {
  total: 'Die Gesamtgrenze der Teilnehmenden ist erreicht.',
  sc: 'Die Grenze für SC ist erreicht.',
  nsc: 'Die Grenze für NSC ist erreicht.',
};
