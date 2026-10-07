import { query } from '../db.js';

export const DEFAULT_BASE_URL = 'http://localhost:3000';

export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name, quota_mb_per_character, invitation_ttl_days, character_browsing_enabled, waitlist_auto_promote, waiver_text, waiver_version, base_url, coming_soon_enabled, coming_soon_message, coming_soon_until, theme_mode, color_scheme, custom_colors, pdf_import_enabled, pdf_export_enabled, tavern_enabled, lodging_enabled, background_preset, background_opacity, unpaid_reminder_days, logo_data IS NOT NULL AS has_uploaded_logo, ticket_bg_data IS NOT NULL AS has_uploaded_ticket_background, background_image_data IS NOT NULL AS has_uploaded_background_image FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, characterBrowsingEnabled: false, waitlistAutoPromote: true, waiverText: '', waiverVersion: 1, baseUrl: null, effectiveBaseUrl: process.env.APP_BASE_URL || DEFAULT_BASE_URL, comingSoonEnabled: false, comingSoonMessage: '', comingSoonUntil: null, themeMode: 'light', colorScheme: 'sahara', customColors: null, pdfImportEnabled: false, pdfExportEnabled: false, tavernEnabled: false, lodgingEnabled: false, backgroundPreset: 'grunge', backgroundOpacity: 20, unpaidReminderDays: [], hasUploadedLogo: false, hasUploadedTicketBackground: false, hasUploadedBackgroundImage: false };
  return {
    logoUrl: rows[0].logo_url,
    appTitle: rows[0].app_title,
    eventName: rows[0].event_name,
    quotaMbPerCharacter: rows[0].quota_mb_per_character,
    invitationTtlDays: rows[0].invitation_ttl_days,
    characterBrowsingEnabled: rows[0].character_browsing_enabled,
    waitlistAutoPromote: rows[0].waitlist_auto_promote,
    waiverText: rows[0].waiver_text,
    waiverVersion: rows[0].waiver_version,
    baseUrl: rows[0].base_url,
    effectiveBaseUrl: rows[0].base_url || process.env.APP_BASE_URL || DEFAULT_BASE_URL,
    comingSoonEnabled: rows[0].coming_soon_enabled,
    comingSoonMessage: rows[0].coming_soon_message,
    comingSoonUntil: rows[0].coming_soon_until,
    themeMode: rows[0].theme_mode,
    colorScheme: rows[0].color_scheme,
    customColors: rows[0].custom_colors,
    pdfImportEnabled: rows[0].pdf_import_enabled,
    pdfExportEnabled: rows[0].pdf_export_enabled,
    tavernEnabled: rows[0].tavern_enabled,
    lodgingEnabled: rows[0].lodging_enabled,
    backgroundPreset: rows[0].background_preset,
    backgroundOpacity: rows[0].background_opacity,
    unpaidReminderDays: rows[0].unpaid_reminder_days ?? [],
    hasUploadedLogo: rows[0].has_uploaded_logo,
    hasUploadedTicketBackground: rows[0].has_uploaded_ticket_background,
    hasUploadedBackgroundImage: rows[0].has_uploaded_background_image,
  };
}

export async function setAppSettings({
  logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled, waitlistAutoPromote,
  waiverText, baseUrl, comingSoonEnabled, comingSoonMessage, comingSoonUntil, themeMode, colorScheme, customColors, pdfImportEnabled, pdfExportEnabled, tavernEnabled, lodgingEnabled, backgroundPreset, backgroundOpacity, unpaidReminderDays,
}) {
  const id = await ensureSettingsRow();
  // Auto-bumps waiver_version whenever the text actually changes, so a
  // participant's stored waiver_version_accepted always identifies exactly
  // which wording they agreed to -- no separate version field for an admin
  // to remember to increment (and forget) themselves.
  let waiverVersionBump = null;
  if (waiverText !== undefined) {
    const current = await getAppSettings();
    if (waiverText !== current.waiverText) waiverVersionBump = current.waiverVersion + 1;
  }
  // baseUrl needs tri-state handling that COALESCE can't express: undefined
  // ("field not submitted") must keep the stored value, while '' ("admin
  // cleared the field") must overwrite it with NULL to fall back to
  // APP_BASE_URL again -- COALESCE($n, col) can never produce NULL from a
  // non-NULL column.
  const baseUrlProvided = baseUrl !== undefined;
  const baseUrlValue = baseUrl === '' ? null : (baseUrl ?? null);
  // comingSoonUntil needs the same tri-state handling as baseUrl: undefined
  // keeps the stored value, '' or null clears it back to "no countdown".
  const comingSoonUntilProvided = comingSoonUntil !== undefined;
  const comingSoonUntilValue = (comingSoonUntil === '' || comingSoonUntil == null) ? null : new Date(comingSoonUntil);
  // customColors needs the same tri-state handling as baseUrl: undefined
  // keeps the stored palette, null clears it back to "no custom palette"
  // (e.g. when the admin switches colorScheme away from 'custom').
  const customColorsProvided = customColors !== undefined;
  const customColorsValue = customColors == null ? null : JSON.stringify(customColors);
  await query(
    `UPDATE app_settings SET
       logo_url = COALESCE($2, logo_url),
       app_title = COALESCE($3, app_title),
       event_name = COALESCE($4, event_name),
       quota_mb_per_character = COALESCE($5, quota_mb_per_character),
       invitation_ttl_days = COALESCE($6, invitation_ttl_days),
       character_browsing_enabled = COALESCE($7, character_browsing_enabled),
       waitlist_auto_promote = COALESCE($8, waitlist_auto_promote),
       waiver_text = COALESCE($9, waiver_text),
       waiver_version = COALESCE($10, waiver_version),
       base_url = CASE WHEN $11 THEN $12 ELSE base_url END,
       coming_soon_enabled = COALESCE($13, coming_soon_enabled),
       coming_soon_message = COALESCE($14, coming_soon_message),
       coming_soon_until = CASE WHEN $15 THEN $16 ELSE coming_soon_until END,
       theme_mode = COALESCE($17, theme_mode),
       color_scheme = COALESCE($18, color_scheme),
       custom_colors = CASE WHEN $19 THEN $20 ELSE custom_colors END,
       pdf_import_enabled = COALESCE($21, pdf_import_enabled),
       tavern_enabled = COALESCE($22, tavern_enabled),
       lodging_enabled = COALESCE($23, lodging_enabled),
       background_preset = COALESCE($24, background_preset),
       background_opacity = COALESCE($25, background_opacity),
       pdf_export_enabled = COALESCE($26, pdf_export_enabled),
       unpaid_reminder_days = COALESCE($27, unpaid_reminder_days)
     WHERE id = $1`,
    [
      id, logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null,
      invitationTtlDays ?? null, characterBrowsingEnabled ?? null, waitlistAutoPromote ?? null,
      waiverText ?? null, waiverVersionBump, baseUrlProvided, baseUrlValue,
      comingSoonEnabled ?? null, comingSoonMessage ?? null, comingSoonUntilProvided, comingSoonUntilValue,
      themeMode ?? null, colorScheme ?? null, customColorsProvided, customColorsValue,
      pdfImportEnabled ?? null, tavernEnabled ?? null, lodgingEnabled ?? null, backgroundPreset ?? null, backgroundOpacity ?? null, pdfExportEnabled ?? null, unpaidReminderDays ?? null,
    ]
  );
  return getAppSettings();
}

async function ensureSettingsRow() {
  const { rows } = await query('SELECT id FROM app_settings LIMIT 1');
  if (rows.length > 0) return rows[0].id;
  const { rows: inserted } = await query('INSERT INTO app_settings DEFAULT VALUES RETURNING id');
  return inserted[0].id;
}

export async function getUploadedLogo() {
  const { rows } = await query('SELECT logo_data, logo_mime_type FROM app_settings WHERE logo_data IS NOT NULL LIMIT 1');
  if (rows.length === 0) return null;
  return { data: rows[0].logo_data, mimeType: rows[0].logo_mime_type };
}

export async function setLogo({ data, mimeType }) {
  const id = await ensureSettingsRow();
  await query('UPDATE app_settings SET logo_data = $2, logo_mime_type = $3 WHERE id = $1', [id, data, mimeType]);
}

export async function clearLogo() {
  await query('UPDATE app_settings SET logo_data = NULL, logo_mime_type = NULL');
}

export async function getUploadedTicketBackground() {
  const { rows } = await query('SELECT ticket_bg_data, ticket_bg_mime_type FROM app_settings WHERE ticket_bg_data IS NOT NULL LIMIT 1');
  if (rows.length === 0) return null;
  return { data: rows[0].ticket_bg_data, mimeType: rows[0].ticket_bg_mime_type };
}

export async function setTicketBackground({ data, mimeType }) {
  const id = await ensureSettingsRow();
  await query('UPDATE app_settings SET ticket_bg_data = $2, ticket_bg_mime_type = $3 WHERE id = $1', [id, data, mimeType]);
}

export async function clearTicketBackground() {
  await query('UPDATE app_settings SET ticket_bg_data = NULL, ticket_bg_mime_type = NULL');
}

export async function getUploadedBackgroundImage() {
  const { rows } = await query('SELECT background_image_data, background_image_mime_type FROM app_settings WHERE background_image_data IS NOT NULL LIMIT 1');
  if (rows.length === 0) return null;
  return { data: rows[0].background_image_data, mimeType: rows[0].background_image_mime_type };
}

export async function setBackgroundImage({ data, mimeType }) {
  const id = await ensureSettingsRow();
  // Uploading a picture selects it as the background.
  await query("UPDATE app_settings SET background_image_data = $2, background_image_mime_type = $3, background_preset = 'custom' WHERE id = $1", [id, data, mimeType]);
}

export async function clearBackgroundImage() {
  await query("UPDATE app_settings SET background_image_data = NULL, background_image_mime_type = NULL, background_preset = CASE WHEN background_preset = 'custom' THEN 'grunge' ELSE background_preset END");
}
