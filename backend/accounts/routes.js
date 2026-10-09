import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { hotkeysError } from './hotkeys.js';
import { getAccount, updateAccount } from './repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { isTestModeEnabled } from '../testMode/load.js';
import { getSummary } from '../instanceAuthority/repository.js';
import { query } from '../db.js';
import { verifyPassword, hashPassword } from '../crypto/password.js';
import { isValidPassword } from '../validation.js';
import { isRateLimited } from '../middleware/rateLimit.js';
import { parseCookies, SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { logAudit } from '../audit/repository.js';

// Change the own password: the current one is required (a stolen session alone must not be enough), and every
// other session of the account is ended so a leaked login stops working.
router.put('/account/password', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { currentPassword, newPassword } = body;
  if (!isValidPassword(newPassword)) return { status: 400, body: { error: 'Das neue Passwort muss mindestens 8 Zeichen lang sein.' } };
  // Per account (not per address): guessing the current password through a session is limited to a few tries.
  if (isRateLimited(`password-change:${user.id}`, 5, 15 * 60 * 1000)) {
    return { status: 429, body: { error: 'Zu viele Versuche. Bitte später erneut versuchen.' } };
  }
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  const stored = rows[0]?.password_hash;
  // An account without a password yet (e.g. created through a link) may set its first one without a "current" one.
  if (stored) {
    if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, stored))) {
      return { status: 400, body: { error: 'Das aktuelle Passwort stimmt nicht.' } };
    }
    if (currentPassword === newPassword) return { status: 400, body: { error: 'Das neue Passwort muss sich vom alten unterscheiden.' } };
  }
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(newPassword)]);
  const keep = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  await query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [user.id, keep ?? '']);
  await logAudit({ actorId: user.id, action: 'auth.password_changed', subjectUserId: user.id, details: {} });
  return { status: 200, body: { changed: true } };
}));

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
