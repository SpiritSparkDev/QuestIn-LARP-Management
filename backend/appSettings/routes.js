import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import {
  getAppSettings, setAppSettings, getUploadedLogo, setLogo, clearLogo,
  getUploadedTicketBackground, setTicketBackground, clearTicketBackground,
} from './repository.js';

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

const IMAGE_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BODY_BYTES = 3 * 1024 * 1024;

// Shared by /app-settings/logo and /app-settings/ticket-background, whose
// upload bodies and validation rules are identical. Returns either
// { error: {status, body} } or { data, mimeType } -- never throws, so
// callers can just check `.error`.
async function parseImageUpload(req, label) {
  const body = await readJsonBody(req, MAX_IMAGE_UPLOAD_BODY_BYTES);
  if (body === null) return { error: { status: 400, body: { error: 'invalid JSON' } } };
  const { dataBase64, mimeType } = body;

  if (!IMAGE_MIME_ALLOWLIST.includes(mimeType)) {
    return { error: { status: 400, body: { error: `mimeType must be one of: ${IMAGE_MIME_ALLOWLIST.join(', ')}` } } };
  }
  // Buffer.from silently ignores the 'base64' encoding argument for a
  // non-string (e.g. an array-like {length: N}), allocating a zero-filled
  // buffer of that length instead -- a small request can force a huge,
  // slow allocation this way. Reject anything that isn't a real string
  // before it ever reaches Buffer.from.
  if (typeof dataBase64 !== 'string') {
    return { error: { status: 400, body: { error: 'dataBase64 must be a base64 string' } } };
  }

  let data;
  try {
    data = Buffer.from(dataBase64, 'base64');
  } catch {
    return { error: { status: 400, body: { error: 'dataBase64 is not valid base64' } } };
  }
  if (data.length === 0) return { error: { status: 400, body: { error: 'dataBase64 is required' } } };
  if (data.length > MAX_IMAGE_BYTES) {
    return { error: { status: 413, body: { error: `${label} exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit` } } };
  }

  return { data, mimeType };
}

router.put('/app-settings/logo', requireAuth(requireAdminGroup(async ({ req }) => {
  const upload = await parseImageUpload(req, 'logo');
  if (upload.error) return upload.error;
  await setLogo(upload);
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

router.put('/app-settings/ticket-background', requireAuth(requireAdminGroup(async ({ req }) => {
  const upload = await parseImageUpload(req, 'ticket background image');
  if (upload.error) return upload.error;
  await setTicketBackground(upload);
  return { status: 200, body: await getAppSettings() };
})));

router.delete('/app-settings/ticket-background', requireAuth(requireAdminGroup(async () => {
  await clearTicketBackground();
  return { status: 200, body: await getAppSettings() };
})));

router.get('/app-settings/ticket-background', async () => {
  const image = await getUploadedTicketBackground();
  if (!image) return { status: 404, body: { error: 'no ticket background uploaded' } };
  return { status: 200, isBinary: true, body: image.data, headers: { 'Content-Type': image.mimeType, 'X-Content-Type-Options': 'nosniff' } };
});
