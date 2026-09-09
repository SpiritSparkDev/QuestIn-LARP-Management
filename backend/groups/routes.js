import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listGroups, getGroup, createGroup, updateGroup } from './repository.js';
import { ACCOUNT_FIELD_KEYS } from '../accountFields.js';
import { REGISTRATION_FIELD_KEYS } from '../registrationFields.js';

const MENU_KEYS = ['konto', 'charaktere', 'con-anmeldungen', 'mitglieder', 'events', 'checkin'];
const KEY_PATTERN = /^[a-z0-9_]+$/;
const ALLOWED_ACCOUNT_FIELD_KEYS = [...ACCOUNT_FIELD_KEYS, ...REGISTRATION_FIELD_KEYS];

function isValidMenuList(value) {
  return Array.isArray(value) && value.every((v) => MENU_KEYS.includes(v));
}

function isValidFieldList(value) {
  return Array.isArray(value) && value.every((v) => ALLOWED_ACCOUNT_FIELD_KEYS.includes(v));
}

router.get('/groups', requireAuth(requireAdminGroup(async () => {
  const groups = await listGroups();
  return { status: 200, body: groups };
})));

router.post('/groups', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { key, name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus } = body;
  if (!key || !KEY_PATTERN.test(key)) {
    return { status: 400, body: { error: 'key is required and must contain only lowercase letters, digits, and underscores' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }
  if (visibleMenus !== undefined && !isValidMenuList(visibleMenus)) {
    return { status: 400, body: { error: `visibleMenus must be an array containing only: ${MENU_KEYS.join(', ')}` } };
  }
  if (accountFields !== undefined && !isValidFieldList(accountFields)) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${ALLOWED_ACCOUNT_FIELD_KEYS.join(', ')}` } };
  }
  try {
    const group = await createGroup({ key, name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus });
    return { status: 201, body: group };
  } catch (err) {
    if (err.code === '23505') return { status: 409, body: { error: 'a group with this key already exists' } };
    throw err;
  }
})));

router.put('/groups/:id', requireAuth(requireAdminGroup(async ({ req, params }) => {
  const existing = await getGroup(params.id);
  if (!existing) return { status: 404, body: { error: 'group not found' } };
  if (existing.is_protected) {
    return { status: 403, body: { error: "the admin group's permissions cannot be edited" } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus } = body;
  if (visibleMenus !== undefined && !isValidMenuList(visibleMenus)) {
    return { status: 400, body: { error: `visibleMenus must be an array containing only: ${MENU_KEYS.join(', ')}` } };
  }
  if (accountFields !== undefined && !isValidFieldList(accountFields)) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${ALLOWED_ACCOUNT_FIELD_KEYS.join(', ')}` } };
  }
  const group = await updateGroup(params.id, { name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus });
  return { status: 200, body: group };
})));
