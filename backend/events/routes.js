import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { createEvent, getEvent, listEvents, updateEvent, activateEvent, deleteEvent } from './repository.js';
import { maybePromoteFromWaitlist } from '../registrations/repository.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

router.post('/events', requireAuth(requireMenu('events')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, code, capacity, flags, pricing } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (capacity !== undefined && capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  if (flags !== undefined && (!Array.isArray(flags) || flags.some((f) => typeof f !== 'string'))) {
    return { status: 400, body: { error: 'flags must be an array of strings' } };
  }
  if (pricing !== undefined) {
    const pricingError = validatePricing(pricing);
    if (pricingError) return { status: 400, body: { error: pricingError } };
  }
  const event = await createEvent({ name, eventDate, code, capacity, flags, pricing });
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
  if (body.pricing !== undefined) {
    const pricingError = validatePricing(body.pricing);
    if (pricingError) return { status: 400, body: { error: pricingError } };
  }
  const before = await getEvent(params.id);
  if (!before) return { status: 404, body: { error: 'event not found' } };
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
