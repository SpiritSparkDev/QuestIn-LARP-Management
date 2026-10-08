import { query } from '../db.js';

const KINDS = ['privacy', 'imprint'];

export async function getLegalDocuments() {
  const { rows } = await query('SELECT privacy_mode, privacy_url, privacy_html, imprint_mode, imprint_url, imprint_html FROM app_settings LIMIT 1');
  const row = rows[0] ?? {};
  return Object.fromEntries(KINDS.map((kind) => [kind, {
    mode: row[`${kind}_mode`] ?? null,
    url: row[`${kind}_url`] ?? '',
    html: row[`${kind}_html`] ?? '',
  }]));
}

// docs: { privacy?: {mode,url,html}, imprint?: {...} }, already validated/sanitized.
export async function setLegalDocuments(docs) {
  let { rows } = await query('SELECT id FROM app_settings LIMIT 1');
  if (rows.length === 0) ({ rows } = await query('INSERT INTO app_settings DEFAULT VALUES RETURNING id'));
  for (const kind of KINDS) {
    if (!docs[kind]) continue;
    const { mode, url, html } = docs[kind];
    // kind comes from the fixed KINDS list, never from the request.
    await query(`UPDATE app_settings SET ${kind}_mode = $2, ${kind}_url = $3, ${kind}_html = $4 WHERE id = $1`, [rows[0].id, mode, url, html]);
  }
  return getLegalDocuments();
}
