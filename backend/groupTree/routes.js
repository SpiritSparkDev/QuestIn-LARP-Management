import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { isValidEmail } from '../validation.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logAudit } from '../audit/repository.js';
import { listCharactersForUser } from '../characters/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import {
  isGroupAncestorOf, inviteByEmail, inviteById, setGroupName, setGroupFields, acceptInvitation, declineInvitation, cancelInvitation,
  leaveParentGroup, removeChild, getGroupTree, createJoinCode, redeemJoinCode,
} from './repository.js';

const INVITE_RATE_LIMIT = { keyPrefix: 'group-invite', maxAttempts: 20, windowMs: 15 * 60 * 1000 };
const REDEEM_RATE_LIMIT = { keyPrefix: 'group-redeem', maxAttempts: 10, windowMs: 15 * 60 * 1000 };

router.get('/group-tree', requireAuth(async ({ user }) => ({ status: 200, body: await getGroupTree(user.id) })));

router.patch('/group-tree/name', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : null;
  if (name === null || name.length > 60) return { status: 400, body: { error: 'Der Gruppenname darf höchstens 60 Zeichen lang sein.' } };
  await setGroupName(user.id, name);
  return { status: 200, body: await getGroupTree(user.id) };
}));

router.patch('/group-tree/fields', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null || typeof body !== 'object') return { status: 400, body: { error: 'invalid JSON' } };
  await setGroupFields(user.id, body);
  return { status: 200, body: await getGroupTree(user.id) };
}));

router.post('/group-tree/invitations', rateLimit(INVITE_RATE_LIMIT)(requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (typeof body.userId === 'string') {
    await inviteById(user.id, body.userId);
    return { status: 202, body: { sent: true } };
  }
  if (typeof body.email !== 'string' || !isValidEmail(body.email.trim())) {
    return { status: 400, body: { error: 'Bitte die vollständige E-Mail-Adresse des anderen Gruppenverwalters angeben.' } };
  }
  await inviteByEmail(user.id, body.email.trim());
  return { status: 202, body: { sent: true } };
})));

router.post('/group-tree/invitations/:id/accept', requireAuth(async ({ params, user }) => {
  if (!(await acceptInvitation(params.id, user.id))) return { status: 404, body: { error: 'Einladung nicht gefunden oder nicht mehr gültig.' } };
  return { status: 200, body: await getGroupTree(user.id) };
}));

router.post('/group-tree/invitations/:id/decline', requireAuth(async ({ params, user }) => {
  if (!(await declineInvitation(params.id, user.id))) return { status: 404, body: { error: 'Einladung nicht gefunden.' } };
  return { status: 200, body: { declined: true } };
}));

router.delete('/group-tree/invitations/:id', requireAuth(async ({ params, user }) => {
  if (!(await cancelInvitation(params.id, user.id))) return { status: 404, body: { error: 'Einladung nicht gefunden.' } };
  return { status: 200, body: { cancelled: true } };
}));

// A manager creates a code and sends it to the manager above them ...
router.post('/group-tree/join-code', requireAuth(async ({ user }) => ({ status: 201, body: await createJoinCode(user.id) })));

// ... who enters it here; the other manager joins directly.
router.post('/group-tree/join-code/redeem', rateLimit(REDEEM_RATE_LIMIT)(requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const name = await redeemJoinCode(user.id, body.code);
  if (!name) return { status: 404, body: { error: 'Der Code ist ungültig, abgelaufen oder kann nicht mehr verwendet werden.' } };
  await logAudit({ actorId: user.id, action: 'group_tree.join_code_redeemed', details: { name } });
  return { status: 200, body: await getGroupTree(user.id) };
})));

router.post('/group-tree/leave', requireAuth(async ({ user }) => {
  await leaveParentGroup(user.id);
  return { status: 200, body: await getGroupTree(user.id) };
}));

router.delete('/group-tree/children/:id', requireAuth(async ({ params, user }) => {
  if (!(await removeChild(user.id, params.id))) return { status: 404, body: { error: 'Untergruppe nicht gefunden.' } };
  return { status: 200, body: await getGroupTree(user.id) };
}));

// The characters of someone in a group below mine, reduced to the fields the
// schema marks "Gruppenverwaltung" -- those are the only ones I may edit.
router.get('/group-tree/persons/:userId/characters', requireAuth(async ({ params, user }) => {
  if (!(await isGroupAncestorOf(user.id, params.userId))) return { status: 404, body: { error: 'Person nicht gefunden.' } };
  const schemas = { sc: await getScCharacterSchema(), nsc: await getNscProfileSchema() };
  const characters = await listCharactersForUser(params.userId);
  await logAudit({ actorId: user.id, action: 'group_tree.view_characters', subjectUserId: params.userId, details: {} });
  return {
    status: 200,
    body: characters.map((c) => {
      const fields = (schemas[c.class] ?? []).filter((f) => f.groupManaged);
      return { id: c.id, name: c.name, class: c.class, fields, data: Object.fromEntries(fields.map((f) => [f.key, c.data?.[f.key]])) };
    }).filter((c) => c.fields.length > 0),
  };
}));
