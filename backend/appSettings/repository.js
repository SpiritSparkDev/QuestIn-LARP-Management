import { query } from '../db.js';

export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name, quota_mb_per_character, invitation_ttl_days, logo_data IS NOT NULL AS has_uploaded_logo, ticket_bg_data IS NOT NULL AS has_uploaded_ticket_background FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, hasUploadedLogo: false, hasUploadedTicketBackground: false };
  return {
    logoUrl: rows[0].logo_url,
    appTitle: rows[0].app_title,
    eventName: rows[0].event_name,
    quotaMbPerCharacter: rows[0].quota_mb_per_character,
    invitationTtlDays: rows[0].invitation_ttl_days,
    hasUploadedLogo: rows[0].has_uploaded_logo,
    hasUploadedTicketBackground: rows[0].has_uploaded_ticket_background,
  };
}

export async function setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays }) {
  const id = await ensureSettingsRow();
  await query(
    'UPDATE app_settings SET logo_url = COALESCE($2, logo_url), app_title = COALESCE($3, app_title), event_name = COALESCE($4, event_name), quota_mb_per_character = COALESCE($5, quota_mb_per_character), invitation_ttl_days = COALESCE($6, invitation_ttl_days) WHERE id = $1',
    [id, logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null, invitationTtlDays ?? null]
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
