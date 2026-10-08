import { router } from '../routes.js';
import { requireAuth, requireGroupManager } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { isValidEmail } from '../validation.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logAudit } from '../audit/repository.js';
import { listCharactersForUser } from '../characters/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { getGroupAccountFields, updateGroupAccountFields } from './accountFields.js';
import {
  isGroupAncestorOf, inviteByEmail, inviteById, setGroupName, setGroupFields, acceptInvitation, declineInvitation, cancelInvitation,
  leaveParentGroup, removeChild, getGroupTree, createJoinCode, deleteJoinCode, redeemJoinCode, CODE_VALIDITIES,
} from './repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_RATE_LIMIT = { keyPrefix: 'group-invite', maxAttempts: 20, windowMs: 15 * 60 * 1000 };
const REDEEM_RATE_LIMIT = { keyPrefix: 'group-redeem', maxAttempts: 10, windowMs: 15 * 60 * 1000 };

router.get('/group-tree', requireAuth(async ({ user }) => ({ status: 200, body: await getGroupTree(user.id) })));

router.patch('/group-tree/name', requireGroupManager(async ({ req, user }) => {
  const body = await readJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : null;
  if (name === null || name.length > 60) return { status: 400, body: { error: 'Der Gruppenname darf höchstens 60 Zeichen lang sein.' } };
  const hadName = (await getGroupTree(user.id)).groupName;
  await setGroupName(user.id, name);
  if (!hadName && name) await logAudit({ actorId: user.id, action: 'group_tree.founded', details: { group: name } });
  return { status: 200, body: await getGroupTree(user.id) };
}));

router.patch('/group-tree/fields', requireGroupManager(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null || typeof body !== 'object') return { status: 400, body: { error: 'invalid JSON' } };
  await setGroupFields(user.id, body);
  return { status: 200, body: await getGroupTree(user.id) };
}));

router.post('/group-tree/invitations', rateLimit(INVITE_RATE_LIMIT)(requireGroupManager(async ({ req, user }) => {
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
  const result = await acceptInvitation(params.id, user.id);
  if (!result) return { status: 404, body: { error: 'Einladung nicht gefunden oder nicht mehr gültig.' } };
  if (result.error) return { status: 409, body: { error: result.error } };
  return { status: 200, body: await getGroupTree(user.id) };
}));

router.post('/group-tree/invitations/:id/decline', requireAuth(async ({ params, user }) => {
  if (!(await declineInvitation(params.id, user.id))) return { status: 404, body: { error: 'Einladung nicht gefunden.' } };
  return { status: 200, body: { declined: true } };
}));

router.delete('/group-tree/invitations/:id', requireGroupManager(async ({ params, user }) => {
  if (!(await cancelInvitation(params.id, user.id))) return { status: 404, body: { error: 'Einladung nicht gefunden.' } };
  return { status: 200, body: { cancelled: true } };
}));

// A group manager hands out codes (validity and number of redemptions are theirs to choose) ...
router.post('/group-tree/join-codes', requireGroupManager(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const max = body.maxRedemptions ?? null;
  if (!Object.hasOwn(CODE_VALIDITIES, body.validity)) return { status: 400, body: { error: 'Bitte eine Gültigkeit wählen (1 Tag, 3 Tage, 7 Tage, 1 Monat oder unbegrenzt).' } };
  if (max !== null && !(Number.isInteger(max) && max >= 1 && max <= 1000000)) return { status: 400, body: { error: 'Die Anzahl der Einlösungen muss eine ganze Zahl ab 1 sein (oder unbegrenzt).' } };
  return { status: 201, body: await createJoinCode(user.id, body.validity, max) };
}));

router.delete('/group-tree/join-codes/:id', requireGroupManager(async ({ params, user }) => {
  if (!UUID_RE.test(params.id) || !(await deleteJoinCode(params.id, user.id))) return { status: 404, body: { error: 'Code nicht gefunden.' } };
  return { status: 200, body: await getGroupTree(user.id) };
}));

// ... and whoever is in no group yet enters one here and joins directly.
router.post('/group-tree/join-code/redeem', rateLimit(REDEEM_RATE_LIMIT)(requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const result = await redeemJoinCode(user.id, body.code);
  if (!result) return { status: 404, body: { error: 'Der Code ist ungültig, abgelaufen, aufgebraucht oder gelöscht.' } };
  if (result.error) return { status: 409, body: { error: result.error } };
  await logAudit({ actorId: user.id, action: 'group_tree.join_code_redeemed', details: { group: result.name } });
  return { status: 200, body: await getGroupTree(user.id) };
})));

router.post('/group-tree/leave', requireAuth(async ({ user }) => {
  await leaveParentGroup(user.id);
  return { status: 200, body: await getGroupTree(user.id) };
}));

router.delete('/group-tree/children/:id', requireGroupManager(async ({ params, user }) => {
  if (!(await removeChild(user.id, params.id))) return { status: 404, body: { error: 'Untergruppe nicht gefunden.' } };
  return { status: 200, body: await getGroupTree(user.id) };
}));

// The characters of someone in a group below mine, reduced to the fields the
// schema marks "Gruppenverwaltung" -- those are the only ones I may edit.
router.get('/group-tree/persons/:userId/characters', requireGroupManager(async ({ params, user }) => {
  if (!(await isGroupAncestorOf(user.id, params.userId))) return { status: 404, body: { error: 'Person nicht gefunden.' } };
  const [scSchema, nscSchema] = [await getScCharacterSchema(), await getNscProfileSchema()];
  const characters = await listCharactersForUser(params.userId);
  await logAudit({ actorId: user.id, action: 'group_tree.view_characters', subjectUserId: params.userId, details: {} });
  // `fields`/`data`: the character sheet; `nscFields`/`nscData`: the NSC questionnaire (PUT /characters/:id/nsc-data).
  const pick = (schema, values) => {
    const fields = schema.filter((f) => f.groupManaged);
    return [fields, Object.fromEntries(fields.map((f) => [f.key, values?.[f.key]]))];
  };
  return {
    status: 200,
    body: characters.map((c) => {
      const [fields, data] = pick(scSchema, c.data);
      const [nscFields, nscData] = pick(nscSchema, c.nscData);
      return { id: c.id, name: c.name, fields, data, nscFields, nscData };
    }).filter((c) => c.fields.length > 0 || c.nscFields.length > 0),
  };
}));

// The account (Konto) fields marked "Gruppenverwaltung" of someone below me.
router.get('/group-tree/persons/:userId/account', requireGroupManager(async ({ params, user }) => {
  const result = UUID_RE.test(params.userId) && await getGroupAccountFields(user.id, params.userId);
  return result ? { status: 200, body: result } : { status: 404, body: { error: 'Person nicht gefunden.' } };
}));

router.patch('/group-tree/persons/:userId/account', requireGroupManager(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null || typeof body !== 'object') return { status: 400, body: { error: 'invalid JSON' } };
  const result = UUID_RE.test(params.userId) && await updateGroupAccountFields(user.id, params.userId, body);
  return result ? { status: 200, body: result } : { status: 404, body: { error: 'Person nicht gefunden.' } };
}));
