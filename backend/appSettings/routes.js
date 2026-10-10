import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import {
  getAppSettings, setAppSettings, getUploadedLogo, setLogo, clearLogo,
  getUploadedTicketBackground, setTicketBackground, clearTicketBackground,
  getUploadedBackgroundImage, setBackgroundImage, clearBackgroundImage, getCapacityRoles, setCapacityRoles,
} from './repository.js';
import { ALL_CON_ROLES } from '../registrations/capacity.js';
import { maybePromoteFromWaitlist } from '../registrations/repository.js';
import { query } from '../db.js';
import { sendComingSoonReminders } from '../comingSoon/notify.js';

const ALLOWED_THEME_MODES = ['light', 'dark'];
const ALLOWED_BACKGROUND_PRESETS = ['none', 'custom', 'grunge', 'netz', 'halle', 'daten', 'marmor', 'nebel', 'metall', 'holz', 'glitzer'];
const ALLOWED_COLOR_SCHEMES = [
  'sahara', 'ozean', 'wald', 'hoehle', 'horror',
  'sahara-intensiv', 'ozean-intensiv', 'wald-intensiv', 'hoehle-intensiv', 'horror-intensiv',
  'custom',
];

// The CSS custom properties (frontend/css/sahara.css :root, minus the "--"
// prefix) an admin can override for colorScheme 'custom'. Kept in sync by
// hand with frontend/js/branding.js's CUSTOM_COLOR_KEYS -- the frontend has
// no access to backend modules to share this list directly. 'shadow' is
// excluded because it's an rgba() value, not a plain hex color the admin
// picker UI can express.
export const ALLOWED_CUSTOM_COLOR_KEYS = [
  'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container',
  'surface-container-high', 'surface-container-highest', 'on-surface', 'on-surface-variant',
  'outline', 'outline-variant', 'primary', 'primary-deep', 'primary-container', 'on-primary',
  'on-primary-container', 'gold', 'gold-container', 'on-gold-container', 'secondary',
  'secondary-container', 'error', 'success',
];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

router.get('/app-settings', async () => {
  const settings = await getAppSettings();
  return { status: 200, body: settings };
});

// Admin: which con roles count against the participant limits (default SC, NSC and direct registrations).
router.get('/admin/settings/capacity-roles', requireAuth(requireAdminGroup(async () => ({ status: 200, body: { roles: await getCapacityRoles(), all: ALL_CON_ROLES } }))));

router.put('/admin/settings/capacity-roles', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null || !Array.isArray(body.roles) || body.roles.some((role) => !ALL_CON_ROLES.includes(role))) {
    return { status: 400, body: { error: `roles must be a list of: ${ALL_CON_ROLES.join(', ')}` } };
  }
  const roles = await setCapacityRoles([...new Set(body.roles)]);
  // Fewer counted roles can free places: let the waiting people move up everywhere.
  const { rows } = await query("SELECT DISTINCT event_id FROM registrations WHERE status = 'waitlisted'");
  for (const row of rows) await maybePromoteFromWaitlist(row.event_id);
  return { status: 200, body: { roles } };
})));

router.put('/app-settings', requireAuth(requireAdminGroup(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const {
    logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled, waitlistAutoPromote,
    waiverText, baseUrl, comingSoonEnabled, comingSoonMessage, comingSoonUntil, themeMode, colorScheme, customColors, pdfImportEnabled, pdfExportEnabled, tavernEnabled, lodgingEnabled, childrenEnabled, childrenCountCapacity, backgroundPreset, backgroundOpacity, unpaidReminderDays,
  } = body;
  if (waiverText !== undefined && typeof waiverText !== 'string') {
    return { status: 400, body: { error: 'waiverText must be a string' } };
  }
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== 'string') {
      return { status: 400, body: { error: 'baseUrl must be a string' } };
    }
    if (baseUrl !== '' && !/^https?:\/\//i.test(baseUrl)) {
      return { status: 400, body: { error: 'baseUrl must start with http:// or https://' } };
    }
  }
  if (quotaMbPerCharacter !== undefined && (!Number.isInteger(quotaMbPerCharacter) || quotaMbPerCharacter < 1)) {
    return { status: 400, body: { error: 'quotaMbPerCharacter must be a positive integer' } };
  }
  if (invitationTtlDays !== undefined && (!Number.isInteger(invitationTtlDays) || invitationTtlDays < 1)) {
    return { status: 400, body: { error: 'invitationTtlDays must be a positive integer' } };
  }
  if (unpaidReminderDays !== undefined && !(Array.isArray(unpaidReminderDays) && unpaidReminderDays.length <= 3
    && unpaidReminderDays.every((d) => Number.isInteger(d) && d >= 1 && d <= 365))) {
    return { status: 400, body: { error: 'unpaidReminderDays must be a list of up to 3 whole numbers from 1 to 365' } };
  }
  if (characterBrowsingEnabled !== undefined && typeof characterBrowsingEnabled !== 'boolean') {
    return { status: 400, body: { error: 'characterBrowsingEnabled must be a boolean' } };
  }
  if (waitlistAutoPromote !== undefined && typeof waitlistAutoPromote !== 'boolean') {
    return { status: 400, body: { error: 'waitlistAutoPromote must be a boolean' } };
  }
  if (tavernEnabled !== undefined && typeof tavernEnabled !== 'boolean') {
    return { status: 400, body: { error: 'tavernEnabled must be a boolean' } };
  }
  if (backgroundOpacity !== undefined && (!Number.isInteger(backgroundOpacity) || backgroundOpacity < 0 || backgroundOpacity > 100)) {
    return { status: 400, body: { error: 'backgroundOpacity must be an integer from 0 to 100' } };
  }
  if (backgroundPreset !== undefined && !ALLOWED_BACKGROUND_PRESETS.includes(backgroundPreset)) {
    return { status: 400, body: { error: `backgroundPreset must be one of: ${ALLOWED_BACKGROUND_PRESETS.join(', ')}` } };
  }
  if (backgroundPreset === 'custom' && !(await getUploadedBackgroundImage())) {
    return { status: 400, body: { error: 'Es ist kein eigenes Hintergrundbild hochgeladen.' } };
  }
  if (lodgingEnabled !== undefined && typeof lodgingEnabled !== 'boolean') {
    return { status: 400, body: { error: 'lodgingEnabled must be a boolean' } };
  }
  if (childrenEnabled !== undefined && typeof childrenEnabled !== 'boolean') {
    return { status: 400, body: { error: 'childrenEnabled must be a boolean' } };
  }
  if (childrenCountCapacity !== undefined && typeof childrenCountCapacity !== 'boolean') {
    return { status: 400, body: { error: 'childrenCountCapacity must be a boolean' } };
  }
  if (pdfImportEnabled !== undefined && typeof pdfImportEnabled !== 'boolean') {
    return { status: 400, body: { error: 'pdfImportEnabled must be a boolean' } };
  }
  if (pdfExportEnabled !== undefined && typeof pdfExportEnabled !== 'boolean') {
    return { status: 400, body: { error: 'pdfExportEnabled must be a boolean' } };
  }
  if (comingSoonEnabled !== undefined && typeof comingSoonEnabled !== 'boolean') {
    return { status: 400, body: { error: 'comingSoonEnabled must be a boolean' } };
  }
  if (comingSoonMessage !== undefined && typeof comingSoonMessage !== 'string') {
    return { status: 400, body: { error: 'comingSoonMessage must be a string' } };
  }
  if (comingSoonUntil !== undefined && comingSoonUntil !== null && comingSoonUntil !== '') {
    if (typeof comingSoonUntil !== 'string' || Number.isNaN(new Date(comingSoonUntil).getTime())) {
      return { status: 400, body: { error: 'comingSoonUntil must be a valid date string' } };
    }
  }
  if (themeMode !== undefined && !ALLOWED_THEME_MODES.includes(themeMode)) {
    return { status: 400, body: { error: `themeMode must be one of: ${ALLOWED_THEME_MODES.join(', ')}` } };
  }
  if (colorScheme !== undefined && !ALLOWED_COLOR_SCHEMES.includes(colorScheme)) {
    return { status: 400, body: { error: `colorScheme must be one of: ${ALLOWED_COLOR_SCHEMES.join(', ')}` } };
  }
  if (customColors !== undefined && customColors !== null) {
    if (typeof customColors !== 'object' || Array.isArray(customColors)) {
      return { status: 400, body: { error: 'customColors must be an object' } };
    }
    for (const [key, value] of Object.entries(customColors)) {
      if (!ALLOWED_CUSTOM_COLOR_KEYS.includes(key)) {
        return { status: 400, body: { error: `customColors has an unknown key: ${key}` } };
      }
      if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) {
        return { status: 400, body: { error: `customColors.${key} must be a hex color like #a1b2c3` } };
      }
    }
  }
  // Only read the pre-update value when a disable is actually possible --
  // avoids an extra query on the common PUT /app-settings call, which never
  // touches comingSoonEnabled at all (branding/theme/etc. edits).
  const wasComingSoonEnabled = comingSoonEnabled === false ? (await getAppSettings()).comingSoonEnabled : false;
  // Children that stop counting free places (see registrations/children.js).
  const childrenSettingTouched = childrenEnabled !== undefined || childrenCountCapacity !== undefined;

  const saved = await setAppSettings({
    logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled, waitlistAutoPromote, waiverText,
    baseUrl: baseUrl === undefined ? undefined : baseUrl.replace(/\/+$/, ''),
    comingSoonEnabled, comingSoonMessage, comingSoonUntil, themeMode, colorScheme, customColors, pdfImportEnabled, pdfExportEnabled, tavernEnabled, lodgingEnabled, childrenEnabled, childrenCountCapacity, backgroundPreset, backgroundOpacity, unpaidReminderDays,
  });

  // Fire-and-forget: sendComingSoonReminders never throws (own try/catch per
  // recipient), so this must not be awaited before responding to the admin.
  if (comingSoonEnabled === false && wasComingSoonEnabled) {
    sendComingSoonReminders(user.id);
  }

  // Children no longer counting can free places: let the waiting people move up everywhere.
  if (childrenSettingTouched) {
    const { rows } = await query("SELECT DISTINCT event_id FROM registrations WHERE status = 'waitlisted'");
    for (const row of rows) await maybePromoteFromWaitlist(row.event_id);
  }

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

router.put('/app-settings/background-image', requireAuth(requireAdminGroup(async ({ req }) => {
  const upload = await parseImageUpload(req, 'background image');
  if (upload.error) return upload.error;
  await setBackgroundImage(upload);
  return { status: 200, body: await getAppSettings() };
})));

router.delete('/app-settings/background-image', requireAuth(requireAdminGroup(async () => {
  await clearBackgroundImage();
  return { status: 200, body: await getAppSettings() };
})));

router.get('/app-settings/background-image', async () => {
  const image = await getUploadedBackgroundImage();
  if (!image) return { status: 404, body: { error: 'no background image uploaded' } };
  return { status: 200, isBinary: true, body: image.data, headers: { 'Content-Type': image.mimeType, 'X-Content-Type-Options': 'nosniff' } };
});
