import { ALL_RULE_OPS, isNumericOp, rulesOf, RULE_SOURCES, MAX_RULES_PER_GROUP } from '../../frontend/js/priceGroupRules.js';
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu, requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { createEvent, getEvent, listEvents, updateEvent, activateEvent, deleteEvent, setEventEnded, setRegistrationLock } from './repository.js';
import { ALL_CON_ROLES } from '../registrations/capacity.js';
import { logAudit } from '../audit/repository.js';
import { query } from '../db.js';
import { maybePromoteFromWaitlist } from '../registrations/repository.js';
import { validatePrivacyDeletion } from '../privacy/repository.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Map links end up as <a href> on the dashboard, so only http(s) is allowed
// (blocks javascript: URLs). Blank/absent means "not set".
function validateEndDate({ eventDate, endDate }) {
  if (endDate === undefined || endDate === null || endDate === '') return null;
  if (!DATE_RE.test(endDate)) return 'endDate must be a YYYY-MM-DD date';
  if (eventDate && endDate < eventDate) return 'endDate must not be before eventDate';
  return null;
}

function validateMapUrls({ mapsUrl, osmUrl }) {
  for (const [field, value] of [['mapsUrl', mapsUrl], ['osmUrl', osmUrl]]) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value.trim())) {
      return `${field} must be an http(s) URL`;
    }
  }
  return null;
}

// Structural validation for the admin-submitted pricing config -- unlike
// normalizeFlags (which silently cleans up a flat comma-separated
// textfield), a grid of groups x tiers x amounts is built by a dedicated
// editor in the frontend, so a malformed submission signals a bug rather
// than stray whitespace, and gets rejected with a specific message instead
// of silently dropped.
// pricing.groupRules: optional automatic pre-selection of a Teilnahmegruppe from an OT field
// (see frontend/js/priceGroupRules.js). One rule per group at most.
function validateGroupRules(groupRules, groups) {
  if (groupRules === undefined) return null;
  if (typeof groupRules !== 'object' || groupRules === null || Array.isArray(groupRules)) return 'pricing.groupRules must be an object';
  for (const [group, stored] of Object.entries(groupRules)) {
    if (!groups.includes(group)) return `pricing.groupRules: unknown group "${group}"`;
    const rules = rulesOf(stored);
    if (rules.length > MAX_RULES_PER_GROUP) return `pricing.groupRules["${group}"]: at most ${MAX_RULES_PER_GROUP} rules per group`;
    for (const rule of rules) {
      if (typeof rule !== 'object' || rule === null) return `pricing.groupRules["${group}"] must contain objects`;
      if (!RULE_SOURCES.includes(rule.source)) return `pricing.groupRules["${group}"]: source must be one of ${RULE_SOURCES.join(', ')}`;
      if (typeof rule.field !== 'string' || !rule.field) return `pricing.groupRules["${group}"]: field is required`;
      if (!ALL_RULE_OPS.includes(rule.op)) return `pricing.groupRules["${group}"]: unknown comparison`;
      // "eq" fits numbers as well as text/options/booleans, so it is checked by the generic branch.
      if (isNumericOp(rule.op) && rule.op !== 'eq') {
        if (!Number.isFinite(rule.value)) return `pricing.groupRules["${group}"]: value must be a number`;
        if (rule.op === 'between' && (!Number.isFinite(rule.value2) || rule.value2 < rule.value)) return `pricing.groupRules["${group}"]: the upper bound must be a number >= the lower bound`;
      } else if (rule.op !== 'filled' && typeof rule.value !== 'string' && typeof rule.value !== 'boolean' && !Number.isFinite(rule.value)) {
        return `pricing.groupRules["${group}"]: value is required`;
      }
    }
  }
  return null;
}

function validatePricing(pricing) {
  if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing)) {
    return 'pricing must be an object';
  }
  const { groups, tiers } = pricing;
  if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string' || !g.trim())) {
    return 'pricing.groups must be an array of non-empty strings';
  }
  const trimmedGroups = groups.map((g) => g.trim());
  if (new Set(trimmedGroups).size !== trimmedGroups.length) {
    return 'pricing.groups must not contain duplicates';
  }
  const ruleError = validateGroupRules(pricing.groupRules, trimmedGroups);
  if (ruleError) return ruleError;
  if (!Array.isArray(tiers)) return 'pricing.tiers must be an array';
  if (tiers.length > 0 && trimmedGroups.length === 0) {
    return 'pricing.tiers requires at least one group in pricing.groups';
  }
  const tierNames = new Set();
  for (const tier of tiers) {
    if (typeof tier !== 'object' || tier === null) return 'each pricing.tiers entry must be an object';
    const name = typeof tier.name === 'string' ? tier.name.trim() : '';
    if (!name) return 'each pricing tier needs a non-empty name';
    if (tierNames.has(name)) return 'pricing.tiers must not contain duplicate names';
    tierNames.add(name);
    if (tier.conPayer !== undefined && typeof tier.conPayer !== 'boolean') {
      return `pricing tier "${name}": conPayer must be a boolean`;
    }
    if (tier.until !== null && tier.until !== undefined && !DATE_RE.test(tier.until)) {
      return `pricing tier "${name}": until must be null or a YYYY-MM-DD date`;
    }
    if (typeof tier.amounts !== 'object' || tier.amounts === null || Array.isArray(tier.amounts)) {
      return `pricing tier "${name}": amounts must be an object`;
    }
    const amountKeys = Object.keys(tier.amounts);
    if (amountKeys.length !== trimmedGroups.length || !trimmedGroups.every((g) => amountKeys.includes(g))) {
      return `pricing tier "${name}": amounts must have exactly one entry per group`;
    }
    for (const g of trimmedGroups) {
      const amount = tier.amounts[g];
      if (!Number.isInteger(amount) || amount < 0) {
        return `pricing tier "${name}": amount for "${g}" must be a non-negative integer`;
      }
    }
  }
  return null;
}

// Same philosophy as validatePricing: the extras editor builds this
// structure, so a malformed submission is a bug and gets a specific message.
function validateExtras(extras) {
  if (!Array.isArray(extras) || extras.length > 50) return 'extras must be an array of at most 50 entries';
  const names = new Set();
  for (const extra of extras) {
    if (typeof extra !== 'object' || extra === null) return 'each extra must be an object';
    const name = typeof extra.name === 'string' ? extra.name.trim() : '';
    if (!name || name.length > 100) return 'each extra needs a name of 1 to 100 characters';
    if (names.has(name)) return 'extras must not contain duplicate names';
    names.add(name);
    if (!Number.isInteger(extra.priceCents) || extra.priceCents < 0) return `extra "${name}": priceCents must be a non-negative integer`;
    if (extra.capacity !== undefined && extra.capacity !== null && (!Number.isInteger(extra.capacity) || extra.capacity < 1)) {
      return `extra "${name}": capacity must be a positive integer or null`;
    }
    if (extra.description !== undefined && typeof extra.description !== 'string') return `extra "${name}": description must be a string`;
    if (extra.id !== undefined && typeof extra.id !== 'string') return `extra "${name}": id must be a string`;
  }
  return null;
}

// flagDetails: { flagName: description }, flagRenames: { oldName: newName }.
function validateFlagExtras({ flagDetails, flagRenames }) {
  for (const [key, value] of [['flagDetails', flagDetails], ['flagRenames', flagRenames]]) {
    if (value === undefined) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) {
      return `${key} must be an object of strings`;
    }
  }
  return null;
}

function validateLabel({ color }) {
  if (color != null && color !== '' && !/^#[0-9a-fA-F]{6}$/.test(color)) return 'color must be a hex colour like #aa5500';
  return null;
}

function validateLimits({ capacity, hardCapacity, lowSeatsNotice, lowSeatsFrom }) {
  const bad = (v) => v !== undefined && v !== null && (!Number.isInteger(v) || v < 1);
  if (bad(hardCapacity)) return 'hardCapacity must be a positive integer or null';
  if (bad(lowSeatsFrom)) return 'lowSeatsFrom must be a positive integer or null';
  if (lowSeatsNotice !== undefined && typeof lowSeatsNotice !== 'boolean') return 'lowSeatsNotice must be a boolean';
  if (hardCapacity != null && capacity == null) return 'hardCapacity requires capacity';
  if (hardCapacity != null && hardCapacity < capacity) return 'hardCapacity must be >= capacity';
  return null;
}

// Separate limits for SC and NSC (planned places + hard limit each), same rules as the total.
function validateRoleLimits(limits) {
  for (const role of ['sc', 'nsc']) {
    const planned = limits[`${role}Capacity`];
    const hard = limits[`${role}HardCapacity`];
    const bad = (v) => v !== undefined && v !== null && (!Number.isInteger(v) || v < 1);
    if (bad(planned) || bad(hard)) return `${role}Capacity and ${role}HardCapacity must be positive integers or null`;
    if (hard != null && planned == null) return `${role}HardCapacity requires ${role}Capacity`;
    if (hard != null && hard < planned) return `${role}HardCapacity must be >= ${role}Capacity`;
  }
  return null;
}

router.post('/events', requireAuth(requireMenu('events')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, endDate, code, capacity, hardCapacity, scCapacity, scHardCapacity, nscCapacity, nscHardCapacity, lowSeatsNotice, lowSeatsFrom, paymentsOpen, color, flags, flagDetails, pricing, extras, directions, briefing, address, mapsUrl, osmUrl } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (capacity !== undefined && capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  const limitError = validateLimits({ capacity: capacity ?? null, hardCapacity: hardCapacity ?? null, lowSeatsNotice, lowSeatsFrom });
  if (limitError) return { status: 400, body: { error: limitError } };
  const roleLimitError = validateRoleLimits({ scCapacity, scHardCapacity, nscCapacity, nscHardCapacity });
  if (roleLimitError) return { status: 400, body: { error: roleLimitError } };
  if (paymentsOpen !== undefined && typeof paymentsOpen !== 'boolean') return { status: 400, body: { error: 'paymentsOpen must be a boolean' } };
  const labelError = validateLabel({ color });
  if (labelError) return { status: 400, body: { error: labelError } };
  if (flags !== undefined && (!Array.isArray(flags) || flags.some((f) => typeof f !== 'string'))) {
    return { status: 400, body: { error: 'flags must be an array of strings' } };
  }
  const flagExtrasError = validateFlagExtras({ flagDetails });
  if (flagExtrasError) return { status: 400, body: { error: flagExtrasError } };
  if (pricing !== undefined) {
    const pricingError = validatePricing(pricing);
    if (pricingError) return { status: 400, body: { error: pricingError } };
  }
  if (extras !== undefined) {
    const extrasError = validateExtras(extras);
    if (extrasError) return { status: 400, body: { error: extrasError } };
  }
  const endDateError = validateEndDate(body);
  if (endDateError) return { status: 400, body: { error: endDateError } };
  const urlError = validateMapUrls({ mapsUrl, osmUrl });
  if (urlError) return { status: 400, body: { error: urlError } };
  const event = await createEvent({ name, eventDate, endDate, code, capacity, hardCapacity, scCapacity, scHardCapacity, nscCapacity, nscHardCapacity, lowSeatsNotice, lowSeatsFrom, paymentsOpen, color, flags, flagDetails, pricing, extras, directions, briefing, address, mapsUrl, osmUrl });
  return { status: 201, body: event };
})));

router.get('/events', requireAuth(async () => {
  const events = await listEvents();
  return { status: 200, body: events };
}));

router.get('/events/:id', requireAuth(async ({ params }) => {
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
}));

router.put('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.capacity !== undefined && body.capacity !== null && (!Number.isInteger(body.capacity) || body.capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  if (body.flags !== undefined && (!Array.isArray(body.flags) || body.flags.some((f) => typeof f !== 'string'))) {
    return { status: 400, body: { error: 'flags must be an array of strings' } };
  }
  const flagExtrasError = validateFlagExtras(body);
  if (flagExtrasError) return { status: 400, body: { error: flagExtrasError } };
  if (body.pricing !== undefined) {
    const pricingError = validatePricing(body.pricing);
    if (pricingError) return { status: 400, body: { error: pricingError } };
  }
  if (body.extras !== undefined) {
    const extrasError = validateExtras(body.extras);
    if (extrasError) return { status: 400, body: { error: extrasError } };
  }
  const before0 = body.endDate && !body.eventDate ? await getEvent(params.id) : null;
  const endDateError = validateEndDate({ ...body, eventDate: body.eventDate ?? before0?.event_date });
  if (endDateError) return { status: 400, body: { error: endDateError } };
  const urlError = validateMapUrls(body);
  if (urlError) return { status: 400, body: { error: urlError } };
  const privacyError = body.privacyDeletion === undefined ? null : validatePrivacyDeletion(body.privacyDeletion);
  if (privacyError) return { status: 400, body: { error: privacyError } };
  const before = await getEvent(params.id);
  if (!before) return { status: 404, body: { error: 'event not found' } };
  const limitError = validateLimits({
    capacity: body.capacity !== undefined ? body.capacity : before.capacity,
    hardCapacity: body.hardCapacity !== undefined ? body.hardCapacity : before.hard_capacity,
    lowSeatsNotice: body.lowSeatsNotice, lowSeatsFrom: body.lowSeatsFrom,
  });
  if (limitError) return { status: 400, body: { error: limitError } };
  const roleLimitError = validateRoleLimits({
    scCapacity: body.scCapacity !== undefined ? body.scCapacity : before.sc_capacity,
    scHardCapacity: body.scHardCapacity !== undefined ? body.scHardCapacity : before.sc_hard_capacity,
    nscCapacity: body.nscCapacity !== undefined ? body.nscCapacity : before.nsc_capacity,
    nscHardCapacity: body.nscHardCapacity !== undefined ? body.nscHardCapacity : before.nsc_hard_capacity,
  });
  if (roleLimitError) return { status: 400, body: { error: roleLimitError } };
  if (body.paymentsOpen !== undefined && typeof body.paymentsOpen !== 'boolean') return { status: 400, body: { error: 'paymentsOpen must be a boolean' } };
  const labelError = validateLabel(body);
  if (labelError) return { status: 400, body: { error: labelError } };
  // An extra that is already booked can't disappear -- registrations refer to it.
  if (body.extras !== undefined) {
    const keptIds = new Set(body.extras.map((e) => e.id).filter(Boolean));
    for (const old of before.extras ?? []) {
      if (keptIds.has(old.id)) continue;
      const { rows } = await query('SELECT 1 FROM registrations WHERE event_id = $1 AND extras ? $2 LIMIT 1', [params.id, old.id]);
      if (rows.length > 0) return { status: 409, body: { error: `„${old.name}“ ist bereits gebucht und kann nicht entfernt werden.` } };
    }
  }
  const event = await updateEvent(params.id, body);

  // Any limit may have grown (total, SC or NSC): let waiting people move up wherever there is room now.
  const limitFields = ['capacity', 'hard_capacity', 'sc_capacity', 'sc_hard_capacity', 'nsc_capacity', 'nsc_hard_capacity'];
  if (limitFields.some((field) => event[field] !== before[field])) {
    await maybePromoteFromWaitlist(params.id);
  }
  return { status: 200, body: await getEvent(params.id) };
})));

router.post('/events/:id/activate', requireAuth(requireMenu('events')(async ({ params }) => {
  const event = await activateEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));

router.post('/events/:id/end', requireAuth(requireMenu('events')(async ({ params }) => {
  const event = await setEventEnded(params.id, true);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));

router.post('/events/:id/reopen', requireAuth(requireMenu('events')(async ({ params }) => {
  const event = await setEventEnded(params.id, false);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));

router.delete('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = (await readJsonBody(req)) ?? {};
  try {
    const deleted = await deleteEvent(params.id, { force: !!body.force, notify: !!body.notify });
    if (!deleted) return { status: 404, body: { error: 'event not found' } };
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'EVENT_HAS_REGISTRATIONS') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

// Manual registration lock (admin only, takes effect immediately): which con
// roles and which account roles may no longer register themselves for this
// event. Staff registering someone is not affected (backend/registrations/lock.js).
router.put('/events/:id/registration-lock', requireAuth(requireAdminGroup(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const conRoles = [...new Set(body.conRoles ?? [])];
  const groups = [...new Set(body.groups ?? [])];
  const mode = body.mode ?? 'block';
  if (!['block', 'waitlist'].includes(mode)) return { status: 400, body: { error: 'mode must be block or waitlist' } };
  if (!conRoles.every((r) => ALL_CON_ROLES.includes(r))) return { status: 400, body: { error: 'unknown con role' } };
  const { rows: known } = await query('SELECT key FROM groups WHERE key = ANY($1)', [groups]);
  if (known.length !== groups.length) return { status: 400, body: { error: 'unknown group' } };
  const saved = await setRegistrationLock(params.id, { conRoles, groups, mode });
  if (!saved) return { status: 404, body: { error: 'event not found' } };
  await logAudit({ actorId: user.id, action: 'registration.lock_changed', details: { eventId: params.id, ...saved } });
  // Lifting (part of) a lock lets people who were waitlisted because of it move up.
  await maybePromoteFromWaitlist(params.id);
  return { status: 200, body: saved };
})));
