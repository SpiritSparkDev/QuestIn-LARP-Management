import { query } from '../db.js';

export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null };
  return { logoUrl: rows[0].logo_url, appTitle: rows[0].app_title, eventName: rows[0].event_name };
}

export async function setAppSettings({ logoUrl, appTitle, eventName }) {
  const { rows } = await query('SELECT id FROM app_settings LIMIT 1');
  if (rows.length === 0) {
    await query(
      'INSERT INTO app_settings (logo_url, app_title, event_name) VALUES ($1, $2, $3)',
      [logoUrl ?? null, appTitle ?? null, eventName ?? null]
    );
  } else {
    await query(
      'UPDATE app_settings SET logo_url = $2, app_title = $3, event_name = $4 WHERE id = $1',
      [rows[0].id, logoUrl ?? null, appTitle ?? null, eventName ?? null]
    );
  }
  return getAppSettings();
}
