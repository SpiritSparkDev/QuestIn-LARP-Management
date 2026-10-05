import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { query } from '../db.js';
import { isManagedBy } from '../managedPersons/repository.js';
import { updateRegistrationLodging } from '../registrations/repository.js';
import { listLodgings, replaceLodgings } from './repository.js';

const DISABLED = { status: 404, body: { error: 'Unterkünfte sind nicht aktiviert.' } };

function validateLodgings(lodgings) {
  if (!Array.isArray(lodgings) || lodgings.length > 200) return 'lodgings must be an array of at most 200 entries';
  const names = new Set();
  for (const lodging of lodgings) {
    if (typeof lodging !== 'object' || lodging === null) return 'each lodging must be an object';
    const name = typeof lodging.name === 'string' ? lodging.name.trim() : '';
    if (!name || name.length > 100) return 'each lodging needs a name of 1 to 100 characters';
    if (names.has(name)) return 'lodgings must not contain duplicate names';
    names.add(name);
    if (!Number.isInteger(lodging.beds) || lodging.beds < 1 || lodging.beds > 500) return `lodging "${name}": beds must be an integer from 1 to 500`;
    if (lodging.priceCents !== undefined && (!Number.isInteger(lodging.priceCents) || lodging.priceCents < 0)) return `lodging "${name}": priceCents must be a non-negative integer`;
    if (lodging.description !== undefined && typeof lodging.description !== 'string') return `lodging "${name}": description must be a string`;
    if (lodging.id !== undefined && typeof lodging.id !== 'string') return `lodging "${name}": id must be a string`;
  }
  return null;
}

// Free beds for everyone (needed to choose one while registering); the names
// of who sleeps where only for people who are part of the event themselves
// (they have a registration, or manage someone who has) and for staff.
router.get('/events/:id/lodgings', requireAuth(async ({ params, user }) => {
  if (!(await getAppSettings()).lodgingEnabled) return DISABLED;
  if (!(await getEvent(params.id))) return { status: 404, body: { error: 'event not found' } };

  let showNames = ['admin', 'moderator'].includes(user.group.key) || user.group.visibleMenus.includes('checkin');
  if (!showNames) {
    const { rows } = await query(
      `SELECT 1 FROM registrations r
       WHERE r.event_id = $1 AND r.status <> 'cancelled'
         AND (r.user_id = $2 OR EXISTS (SELECT 1 FROM users m WHERE m.id = r.user_id AND m.managed_by_user_id = $2))
       LIMIT 1`,
      [params.id, user.id]
    );
    showNames = rows.length > 0;
  }
  return { status: 200, body: await listLodgings(params.id, { showNames }) };
}));

router.put('/events/:id/lodgings', requireAuth(requireMenu('events')(async ({ req, params }) => {
  if (!(await getAppSettings()).lodgingEnabled) return DISABLED;
  if (!(await getEvent(params.id))) return { status: 404, body: { error: 'event not found' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const error = validateLodgings(body.lodgings);
  if (error) return { status: 400, body: { error } };
  try {
    await replaceLodgings(params.id, body.lodgings);
  } catch (err) {
    if (err.code === 'LODGING_OCCUPIED') return { status: 409, body: { error: err.message } };
    throw err;
  }
  return { status: 200, body: await listLodgings(params.id, { showNames: true }) };
})));

// Choose, switch or give up a bed: the person themself, a manager of a managed
// person, or an admin/moderator.
router.put('/events/:id/registrations/:userId/lodging', requireAuth(async ({ req, params, user }) => {
  const isStaff = ['admin', 'moderator'].includes(user.group.key);
  const isOwner = params.userId === user.id || await isManagedBy(params.userId, user.id);
  if (!isOwner && !isStaff) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    return { status: 200, body: await updateRegistrationLodging(params.id, params.userId, body.lodgingId ?? null, { staff: isStaff }) };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND' || err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'LODGING_DISABLED') return DISABLED;
    if (err.code === 'INVALID_LODGING') return { status: 400, body: { error: err.message } };
    if (err.code === 'LODGING_FULL' || err.code === 'LODGING_LOCKED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));
