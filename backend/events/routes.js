import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { createEvent, getEvent, listEvents, updateEvent, activateEvent, deleteEvent, setEventEnded } from './repository.js';
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

router.post('/events', requireAuth(requireMenu('events')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, endDate, code, capacity, flags, flagDetails, pricing, extras, directions, briefing, address, mapsUrl, osmUrl } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (capacity !== undefined && capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
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
  const event = await createEvent({ name, eventDate, endDate, code, capacity, flags, flagDetails, pricing, extras, directions, briefing, address, mapsUrl, osmUrl });
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

  const effective = (c) => (c === null ? Infinity : c);
  if (effective(event.capacity) > effective(before.capacity)) {
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
