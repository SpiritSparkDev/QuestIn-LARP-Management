import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { hotkeysError } from './hotkeys.js';
import { getAccount, updateAccount } from './repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { isTestModeEnabled } from '../testMode/load.js';
import { getSummary } from '../instanceAuthority/repository.js';

router.get('/account', requireAuth(async ({ user }) => {
  const account = await getAccount(user.id);
  // Drives the admin sidebar's "PDF-Import" link (opt-in add-on).
  const { pdfImportEnabled, pdfExportEnabled, tavernEnabled, lodgingEnabled } = await getAppSettings();
  // While an admin views the tool as another group, the account shows that group's permissions.
  const viewAs = user.viewingAs ? {
    group: { key: user.group.key, name: user.group.name },
    menus: user.group.visibleMenus,
    accountFields: user.group.accountFields,
    canEditCharacters: user.group.canEditCharacters,
    canOverrideCheckinStatus: user.group.canOverrideCheckinStatus,
    canExportMembers: user.group.canExportMembers,
    canExportSensitive: user.group.canExportSensitive,
    canUseOffline: user.group.canUseOffline,
    viewingAs: user.viewingAs,
  } : {};
  return { status: 200, body: { ...account, ...viewAs, pdfImportEnabled, pdfExportEnabled, tavernEnabled, lodgingEnabled, testMode: await isTestModeEnabled(), instance: await getSummary() } };
}));

router.patch('/account', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const hkError = hotkeysError(body.hotkeys);
  if (hkError) return { status: 400, body: { error: hkError } };
  const account = await updateAccount(user.id, body);
  if (!account) return { status: 404, body: { error: 'account not found' } };
  return { status: 200, body: account };
}));
