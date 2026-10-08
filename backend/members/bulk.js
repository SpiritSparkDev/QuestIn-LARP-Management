import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { query } from '../db.js';
import { logAudit } from '../audit/repository.js';
import { getEvent } from '../events/repository.js';
import { reactivateMember } from './repository.js';
import { updateMemberAudited, deactivateChecked } from './actions.js';
import { filterToAllowedFields } from './routes.js';
import { approveRegistration, cancelRegistration } from '../registrations/repository.js';

const MAX_BULK_IDS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One endpoint per action, each running the single-member logic (actions.js /
// registrations repository) per id. Partial success is allowed: the answer lists
// the outcome per id; one audit entry covers the whole run.
// `perId(id)` resolves to null on success or an error string.
function bulkRoute(path, prepare) {
  router.post(path, requireAuth(requireMenu('mitglieder')(async ({ req, user }) => {
    const body = await readJsonBody(req);
    if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((id) => typeof id !== 'string')) {
      return { status: 400, body: { error: 'ids must be a non-empty array of strings' } };
    }
    const ids = [...new Set(body.ids)];
    if (ids.length > MAX_BULK_IDS) return { status: 413, body: { error: `Maximal ${MAX_BULK_IDS} Mitglieder pro Aktion.` } };

    const prepared = await prepare({ body, user });
    if (prepared.status) return { status: prepared.status, body: { error: prepared.error } };

    const results = {};
    for (const id of ids) {
      if (!UUID.test(id)) { results[id] = { ok: false, error: 'ungültige ID' }; continue; }
      try {
        const error = await prepared.perId(id);
        results[id] = error ? { ok: false, error } : { ok: true };
      } catch (err) {
        results[id] = { ok: false, error: err.message };
      }
    }
    const ok = Object.values(results).filter((r) => r.ok).length;
    await logAudit({ actorId: user.id, action: 'members.bulk', details: { action: prepared.action, count: ids.length, ok, failed: ids.length - ok, ids, ...prepared.details } });
    return { status: 200, body: { ok, failed: ids.length - ok, results } };
  })));
}

const failureText = (failure) => failure?.error ?? null;

bulkRoute('/members-bulk/group', async ({ body, user }) => {
  // Same gate as PATCH /members/:id: the viewer's group must be allowed to edit 'group'.
  if ((await filterToAllowedFields({ group: body.group }, user.group.accountFields)).length > 0) {
    return { status: 403, error: 'not permitted to edit: group' };
  }
  const { rows } = await query('SELECT id FROM groups WHERE key = $1', [body.group]);
  if (rows.length === 0) return { status: 400, error: 'unknown group' };
  return {
    action: 'group',
    details: { group: body.group },
    perId: async (id) => {
      if (id.toLowerCase() === user.id.toLowerCase()) return 'Die eigene Rolle kann nicht per Sammelaktion geändert werden.';
      return (await updateMemberAudited(user.id, id, { group: rows[0].id })) ? null : 'member not found';
    },
  };
});

bulkRoute('/members-bulk/deactivate', async ({ user }) => ({
  action: 'deactivate',
  perId: async (id) => failureText(await deactivateChecked(user.id, id)),
}));

bulkRoute('/members-bulk/reactivate', async () => ({
  action: 'reactivate',
  perId: async (id) => ((await reactivateMember(id)) ? null : 'member not found'),
}));

// Same permission and transitions (incl. waitlist promotion on cancel) as POST /events/:id/approve|cancel.
const REGISTRATION_ACTIONS = { approve: approveRegistration, cancel: cancelRegistration };
bulkRoute('/members-bulk/registration', async ({ body, user }) => {
  if (!user.group.canOverrideCheckinStatus) return { status: 403, error: 'forbidden' };
  const run = REGISTRATION_ACTIONS[body.action];
  if (!run) return { status: 400, error: `action must be one of: ${Object.keys(REGISTRATION_ACTIONS).join(', ')}` };
  const event = typeof body.eventId === 'string' && UUID.test(body.eventId) ? await getEvent(body.eventId) : null;
  if (!event) return { status: 404, error: 'event not found' };
  return {
    action: `registration.${body.action}`,
    details: { eventId: event.id, eventName: event.name },
    perId: async (id) => {
      try {
        await run(event.id, id);
        return null;
      } catch (err) {
        if (err.code === 'REGISTRATION_NOT_FOUND') return 'Keine Anmeldung zu diesem Event.';
        if (['NO_CHARACTER', 'INVALID_TRANSITION'].includes(err.code)) return err.message;
        throw err;
      }
    },
  };
});
