import { query } from '../db.js';

export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name, quota_mb_per_character, logo_data FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, hasUploadedLogo: false };
  return {
    logoUrl: rows[0].logo_url,
    appTitle: rows[0].app_title,
    eventName: rows[0].event_name,
    quotaMbPerCharacter: rows[0].quota_mb_per_character,
    hasUploadedLogo: rows[0].logo_data !== null,
  };
}

export async function setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter }) {
  const { rows } = await query('SELECT id FROM app_settings LIMIT 1');
  if (rows.length === 0) {
    await query(
      'INSERT INTO app_settings (logo_url, app_title, event_name, quota_mb_per_character) VALUES ($1, $2, $3, COALESCE($4, 100))',
      [logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null]
    );
  } else {
    await query(
      'UPDATE app_settings SET logo_url = $2, app_title = $3, event_name = $4, quota_mb_per_character = COALESCE($5, quota_mb_per_character) WHERE id = $1',
      [rows[0].id, logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null]
    );
  }
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
