import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

const encryptJson = (value) => encryptField(JSON.stringify(value ?? {}));
const decryptJson = (buffer) => {
  const json = decryptField(buffer);
  return json ? JSON.parse(json) : {};
};

function rowToConfig(row) {
  return {
    templateFilename: row.template_filename,
    pdfFields: row.pdf_fields,
    mapping: row.mapping,
    emailEnabled: row.email_enabled,
  };
}

export async function getPdfImportConfig() {
  const { rows } = await query('SELECT * FROM pdf_import_config LIMIT 1');
  if (rows.length > 0) return rowToConfig(rows[0]);
  const { rows: inserted } = await query('INSERT INTO pdf_import_config DEFAULT VALUES RETURNING *');
  return rowToConfig(inserted[0]);
}

// A new template replaces the detected field list; mapping entries for
// fields that no longer exist are dropped, the rest are kept so re-uploading
// a slightly changed form doesn't lose the admin's work.
export async function setPdfTemplate({ filename, pdfFields }) {
  const current = await getPdfImportConfig();
  const names = new Set(pdfFields.map((f) => f.name));
  const mapping = Object.fromEntries(Object.entries(current.mapping).filter(([name]) => names.has(name)));
  const { rows } = await query(
    'UPDATE pdf_import_config SET template_filename = $1, pdf_fields = $2, mapping = $3 RETURNING *',
    [filename, JSON.stringify(pdfFields.map(({ name, type, options }) => ({ name, type, options }))), JSON.stringify(mapping)]
  );
  return rowToConfig(rows[0]);
}

export async function setPdfImportConfig({ mapping, emailEnabled }) {
  await getPdfImportConfig();
  const { rows } = await query(
    `UPDATE pdf_import_config SET
       mapping = COALESCE($1, mapping),
       email_enabled = COALESCE($2, email_enabled)
     RETURNING *`,
    [mapping === undefined ? null : JSON.stringify(mapping), emailEnabled ?? null]
  );
  return rowToConfig(rows[0]);
}

function rowToImport(row, { withRaw = false } = {}) {
  return {
    id: row.id,
    createdAt: row.created_at,
    sourceFilename: row.source_filename,
    emailSentAt: row.email_sent_at,
    emailError: row.email_error,
    mapped: decryptJson(row.mapped_data_enc),
    ...(withRaw ? { raw: decryptJson(row.raw_data_enc) } : {}),
  };
}

export async function createPdfImport({ createdBy, sourceFilename, raw, mapped }) {
  const { rows } = await query(
    `INSERT INTO pdf_imports (created_by, source_filename, raw_data_enc, mapped_data_enc)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [createdBy, sourceFilename, encryptJson(raw), encryptJson(mapped)]
  );
  return rowToImport(rows[0], { withRaw: true });
}

export async function listPdfImports() {
  const { rows } = await query('SELECT * FROM pdf_imports ORDER BY created_at DESC');
  return rows.map((row) => rowToImport(row));
}

export async function getPdfImport(id) {
  const { rows } = await query('SELECT * FROM pdf_imports WHERE id = $1', [id]);
  return rows.length ? rowToImport(rows[0], { withRaw: true }) : null;
}

export async function deletePdfImport(id) {
  const { rowCount } = await query('DELETE FROM pdf_imports WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function markPdfImportEmail(id, { error = null } = {}) {
  await query(
    'UPDATE pdf_imports SET email_sent_at = CASE WHEN $2::text IS NULL THEN now() ELSE email_sent_at END, email_error = $2 WHERE id = $1',
    [id, error]
  );
}
