import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getAppSettings, setAppSettings, getUploadedLogo, setLogo, clearLogo } from './repository.js';

router.get('/app-settings', async () => {
  const settings = await getAppSettings();
  return { status: 200, body: settings };
});

router.put('/app-settings', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays } = body;
  if (quotaMbPerCharacter !== undefined && (!Number.isInteger(quotaMbPerCharacter) || quotaMbPerCharacter < 1)) {
    return { status: 400, body: { error: 'quotaMbPerCharacter must be a positive integer' } };
  }
  if (invitationTtlDays !== undefined && (!Number.isInteger(invitationTtlDays) || invitationTtlDays < 1)) {
    return { status: 400, body: { error: 'invitationTtlDays must be a positive integer' } };
  }
  const saved = await setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays });
  return { status: 200, body: saved };
})));

const LOGO_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_LOGO_UPLOAD_BODY_BYTES = 3 * 1024 * 1024;

router.put('/app-settings/logo', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req, MAX_LOGO_UPLOAD_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { dataBase64, mimeType } = body;

  if (!LOGO_MIME_ALLOWLIST.includes(mimeType)) {
    return { status: 400, body: { error: `mimeType must be one of: ${LOGO_MIME_ALLOWLIST.join(', ')}` } };
  }
  // Buffer.from silently ignores the 'base64' encoding argument for a
  // non-string (e.g. an array-like {length: N}), allocating a zero-filled
  // buffer of that length instead -- a small request can force a huge,
  // slow allocation this way. Reject anything that isn't a real string
  // before it ever reaches Buffer.from.
  if (typeof dataBase64 !== 'string') {
    return { status: 400, body: { error: 'dataBase64 must be a base64 string' } };
  }

  let data;
  try {
    data = Buffer.from(dataBase64, 'base64');
  } catch {
    return { status: 400, body: { error: 'dataBase64 is not valid base64' } };
  }
  if (data.length === 0) return { status: 400, body: { error: 'dataBase64 is required' } };
  if (data.length > MAX_LOGO_BYTES) {
    return { status: 413, body: { error: `logo exceeds the ${MAX_LOGO_BYTES / (1024 * 1024)}MB limit` } };
  }

  await setLogo({ data, mimeType });
  return { status: 200, body: await getAppSettings() };
})));

router.delete('/app-settings/logo', requireAuth(requireAdminGroup(async () => {
  await clearLogo();
  return { status: 200, body: await getAppSettings() };
})));

router.get('/app-settings/logo', async () => {
  const logo = await getUploadedLogo();
  if (!logo) return { status: 404, body: { error: 'no logo uploaded' } };
  return { status: 200, isBinary: true, body: logo.data, headers: { 'Content-Type': logo.mimeType, 'X-Content-Type-Options': 'nosniff' } };
});
