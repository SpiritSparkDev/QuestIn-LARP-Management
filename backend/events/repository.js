import { rulesOf, MAX_RULES_PER_GROUP } from '../../frontend/js/priceGroupRules.js';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { sendEventDeletedEmail, getTransporterAndFrom } from '../auth/mailer.js';
import { logger } from '../logger.js';

const SELECT_COLUMNS = 'id, name, event_date, end_date, code, capacity, flags, flag_details, pricing, extras, directions, briefing, address, maps_url, osm_url, is_active, ended_at, privacy_deletion, privacy_deleted, created_at';

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

// Descriptions only for flags that exist, trimmed and capped at 500 characters.
function normalizeFlagDetails(details, flags) {
  const result = {};
  if (!details || typeof details !== 'object' || Array.isArray(details)) return result;
  for (const name of normalizeFlags(flags)) {
    if (typeof details[name] === 'string' && details[name].trim()) result[name] = details[name].trim().slice(0, 500);
  }
  return result;
}

// Trims strings and sorts tiers by `until` ascending (null -- "no cutoff,
// last tier" -- sorts last), so resolvePriceForGroup can just take the
// first matching tier without re-sorting on every lookup. Structural
// validity (unique names, amounts matching the group vocabulary exactly,
// well-formed dates) is already enforced by events/routes.js's
// validatePricing before this ever runs -- this only normalizes, it
// doesn't reject.
function normalizePricing(pricing) {
  const groups = Array.isArray(pricing?.groups)
    ? pricing.groups.filter((g) => typeof g === 'string').map((g) => g.trim()).filter(Boolean)
    : [];
  const tiers = Array.isArray(pricing?.tiers) ? pricing.tiers : [];
  const normalizedTiers = tiers.map((t) => ({
    name: String(t.name ?? '').trim(),
    until: t.until ?? null,
    amounts: { ...t.amounts },
    // "Con-Zahler" tier: whoever is priced by it pays at the con.
    conPayer: t.conPayer === true,
  }));
  normalizedTiers.sort((a, b) => {
    const aUntil = a.until ?? '9999-99-99';
    const bUntil = b.until ?? '9999-99-99';
    return aUntil < bUntil ? -1 : aUntil > bUntil ? 1 : 0;
  });
  // Automatic Teilnahmegruppe suggestion per group (already validated in events/routes.js).
  const groupRules = {};
  for (const g of groups) {
    const rules = rulesOf(pricing?.groupRules?.[g]).slice(0, MAX_RULES_PER_GROUP)
      .map((rule) => ({ source: rule.source, field: rule.field, op: rule.op, ...(rule.value !== undefined && { value: rule.value }), ...(rule.value2 !== undefined && { value2: rule.value2 }) }));
    if (rules.length > 0) groupRules[g] = rules;
  }
  return { groups, tiers: normalizedTiers, groupRules };
}

// Keeps an extra's id when it has one (registrations refer to it), otherwise
// mints one. Shape validation already happened in events/routes.js.
function normalizeExtras(extras) {
  if (!Array.isArray(extras)) return [];
  return extras.map((e) => ({
    id: typeof e.id === 'string' && e.id ? e.id : crypto.randomUUID(),
    name: String(e.name).trim(),
    description: typeof e.description === 'string' ? e.description.trim() : '',
    priceCents: e.priceCents,
    capacity: e.capacity ?? null,
  }));
}

// Blank text counts as "not set" so the dashboard's show-only-if-present
// check can be a plain truthiness test.
function normalizeText(value) {
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

export async function createEvent({ name, eventDate, endDate, code, capacity, flags, flagDetails, pricing, extras, directions, briefing, address, mapsUrl, osmUrl }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code, capacity, flags, pricing, extras, directions, briefing, address, maps_url, osm_url, flag_details, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null, capacity ?? null, normalizeFlags(flags), JSON.stringify(normalizePricing(pricing)), JSON.stringify(normalizeExtras(extras)), normalizeText(directions), normalizeText(briefing), normalizeText(address), normalizeText(mapsUrl), normalizeText(osmUrl), JSON.stringify(normalizeFlagDetails(flagDetails, flags)), endDate || null]
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

export async function getEventByCode(code) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM events WHERE code = $1`,
    [code]
  );
  return rows[0] ?? null;
}

export async function listEvents() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM events ORDER BY event_date`
  );
  return rows;
}

export async function updateEvent(id, { privacyDeletion, endDate, name, eventDate, code, capacity, clearCapacity, flags, flagDetails, flagRenames, pricing, extras, directions, briefing, address, mapsUrl, osmUrl }) {
  // code/capacity are the fields a caller can legitimately want to CLEAR
  // (empty string / "unbegrenzt") rather than just omit -- COALESCE alone
  // can't tell those apart, since both arrive as a falsy value. $6/$7
  // carry that distinction explicitly: only skip the write when the field
  // was genuinely absent from the call. flags/pricing don't need this: an
  // empty array/object is not falsy in JS, so `!== undefined` alone tells
  // omitted apart from explicitly-cleared.
  const current = await getEvent(id);
  if (!current) return null;
  // A renamed special role keeps its registrations and its description.
  const renames = Object.entries(flagRenames ?? {}).filter(([from, to]) => typeof to === 'string' && to.trim() && from !== to.trim());
  for (const [from, to] of renames) {
    await query('UPDATE registrations SET flags = array_replace(flags, $2, $3) WHERE event_id = $1 AND $2 = ANY(flags)', [id, from, to.trim()]);
  }
  let nextDetails = null;
  if (flagDetails !== undefined || flags !== undefined) {
    const carried = { ...(current.flag_details ?? {}) };
    for (const [from, to] of renames) {
      if (carried[from] !== undefined) { carried[to.trim()] = carried[from]; delete carried[from]; }
    }
    nextDetails = JSON.stringify(normalizeFlagDetails(flagDetails ?? carried, flags ?? current.flags));
  }
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = CASE WHEN $6 THEN $4 ELSE code END,
       capacity = CASE WHEN $7 THEN $5 ELSE capacity END,
       flags = COALESCE($8, flags),
       pricing = COALESCE($9, pricing),
       directions = CASE WHEN $10 THEN $11 ELSE directions END,
       briefing = CASE WHEN $12 THEN $13 ELSE briefing END,
       address = CASE WHEN $14 THEN $15 ELSE address END,
       maps_url = CASE WHEN $16 THEN $17 ELSE maps_url END,
       osm_url = CASE WHEN $18 THEN $19 ELSE osm_url END,
       extras = COALESCE($20, extras),
       flag_details = COALESCE($21, flag_details),
       privacy_deletion = COALESCE($22, privacy_deletion),
       end_date = CASE WHEN $23 THEN $24 ELSE end_date END
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id, name ?? null, eventDate ?? null, code ?? null, capacity ?? null,
      code !== undefined, capacity !== undefined || Boolean(clearCapacity),
      flags !== undefined ? normalizeFlags(flags) : null,
      pricing !== undefined ? JSON.stringify(normalizePricing(pricing)) : null,
      directions !== undefined, normalizeText(directions),
      briefing !== undefined, normalizeText(briefing),
      address !== undefined, normalizeText(address),
      mapsUrl !== undefined, normalizeText(mapsUrl),
      osmUrl !== undefined, normalizeText(osmUrl),
      extras !== undefined ? JSON.stringify(normalizeExtras(extras)) : null,
      nextDetails,
      privacyDeletion !== undefined ? JSON.stringify(privacyDeletion) : null,
      endDate !== undefined, endDate || null,
    ]
  );
  return rows[0] ?? null;
}

// Picks the price tier that applies "today" for a given participant group:
// the first tier (already sorted by `until` ascending, nulls last -- see
// normalizePricing) whose `until` is null or on/after `atDate`. Returns
// null if the group doesn't exist in this event's pricing, or if every
// tier's `until` has already passed (pricing "exhausted" -- the caller
// should fall back to a manually-entered amount rather than block on this).
export function resolvePriceForGroup(pricing, groupName, atDate = new Date()) {
  if (!pricing?.groups?.includes(groupName)) return null;
  const todayStr = atDate.toISOString().slice(0, 10);
  const tier = (pricing.tiers ?? []).find((t) => t.until == null || todayStr <= t.until);
  if (!tier) return null;
  const amountCents = tier.amounts?.[groupName];
  if (!Number.isInteger(amountCents)) return null;
  return { tierName: tier.name, amountCents, conPayer: tier.conPayer === true };
}

// "Event beenden": from now on Check-Out is possible; null reopens it.
export async function setEventEnded(id, ended) {
  const { rows } = await query(
    `UPDATE events SET ended_at = ${ended ? 'COALESCE(ended_at, now())' : 'NULL'} WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
    [id]
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

  let participants = [];
  if (rows.length > 0 && notify) {
    const { rows: participantRows } = await query(
      'SELECT u.id, u.email FROM users u JOIN registrations r ON r.user_id = u.id WHERE r.event_id = $1',
      [id]
    );
    participants = participantRows;
  }

  // events.registrations has ON DELETE CASCADE, so removing the event row
  // also removes its registrations (and their payments) in one statement.
  await query('DELETE FROM events WHERE id = $1', [id]);

  if (participants.length > 0) {
    const transport = await getTransporterAndFrom();
    for (const { id: userId, email: to } of participants) {
      try {
        await sendEventDeletedEmail(to, { eventName: existing.name, userId }, transport);
      } catch (err) {
        logger.error('failed to send event-deleted notification', { error: err.message, to, eventId: id });
      }
    }
  }

  return true;
}
