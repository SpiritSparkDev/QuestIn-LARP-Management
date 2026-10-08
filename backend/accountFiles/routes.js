import crypto from 'node:crypto';
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getAppSettings } from '../appSettings/repository.js';
import { getStorageSettingsForUse } from '../storageSettings/repository.js';
import { getStorage } from '../storage/index.js';
import { query, withTransaction } from '../db.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
const MIME_ALLOWLIST = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  document: ['application/pdf'],
};
const COLUMNS = 'id, user_id, kind, original_filename, mime_type, size_bytes, is_portrait, storage_backend, storage_key, created_at';

// Own files only -- account files are never shared with anyone else.
async function ownFile(id, userId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM account_files WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] ?? null;
}

router.get('/account/files', requireAuth(async ({ user }) => {
  const { rows } = await query(`SELECT ${COLUMNS} FROM account_files WHERE user_id = $1 ORDER BY created_at`, [user.id]);
  return { status: 200, body: rows };
}));

router.post('/account/files', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { kind, filename, mimeType, dataBase64, gdprConsent } = body;
  if (gdprConsent !== true) return { status: 400, body: { error: 'gdprConsent must be true' } };
  if (!MIME_ALLOWLIST[kind]?.includes(mimeType)) {
    return { status: 400, body: { error: `mimeType must be one of: ${Object.values(MIME_ALLOWLIST).flat().join(', ')}, matching kind "${kind}"` } };
  }
  if (typeof filename !== 'string' || !filename) return { status: 400, body: { error: 'filename is required' } };
  // A non-string (e.g. {length: 4e9}) would make Buffer.from allocate that much.
  if (typeof dataBase64 !== 'string') return { status: 400, body: { error: 'dataBase64 must be a base64 string' } };
  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) return { status: 400, body: { error: 'dataBase64 is required' } };
  if (buffer.length > MAX_FILE_BYTES) {
    return { status: 413, body: { error: `file exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB per-file limit` } };
  }

  // Same per-owner quota as characters.
  const settings = await getAppSettings();
  const { rows: [{ total }] } = await query('SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total FROM account_files WHERE user_id = $1', [user.id]);
  if (Number(total) + buffer.length > settings.quotaMbPerCharacter * 1024 * 1024) {
    return { status: 413, body: { error: 'this account has reached its storage quota' } };
  }

  const id = crypto.randomUUID();
  const storageSettings = await getStorageSettingsForUse();
  const storageKey = `accounts/${user.id}/${id}`;
  try {
    await getStorage(storageSettings.backend, storageSettings).upload(storageKey, buffer);
  } catch (err) {
    return { status: 502, body: { error: `Datei konnte nicht auf dem Speicher-Backend abgelegt werden: ${err.message}` } };
  }
  const { rows } = await query(
    `INSERT INTO account_files (id, user_id, kind, original_filename, mime_type, size_bytes, storage_backend, storage_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
    [id, user.id, kind, filename, mimeType, buffer.length, storageSettings.backend, storageKey]
  );
  return { status: 201, body: rows[0] };
}));

router.get('/account/files/:fileId', requireAuth(async ({ params, user }) => {
  const file = await ownFile(params.fileId, user.id).catch(() => null);
  if (!file) return { status: 404, body: { error: 'not found' } };
  const storage = getStorage(file.storage_backend, await getStorageSettingsForUse());
  let data;
  try {
    data = await storage.download(file.storage_key);
  } catch (err) {
    if (file.storage_backend !== 'local') return { status: 502, body: { error: `Datei konnte nicht vom Speicher-Backend geladen werden: ${err.message}` } };
    return { status: 404, body: { error: 'not found' } };
  }
  return {
    status: 200,
    isBinary: true,
    body: data,
    headers: {
      'Content-Type': file.mime_type,
      'Content-Disposition': `inline; filename="${file.original_filename.replace(/["\r\n]/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  };
}));

// Profile picture: one of the account's own images, or null to clear.
router.put('/account/portrait', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.fileId !== null) {
    const file = typeof body.fileId === 'string' ? await ownFile(body.fileId, user.id).catch(() => null) : null;
    if (!file) return { status: 404, body: { error: 'file not found' } };
    if (file.kind !== 'image') return { status: 400, body: { error: 'only an image can be the profile picture' } };
  }
  await withTransaction(async (client) => {
    await client.query('UPDATE account_files SET is_portrait = false WHERE user_id = $1 AND is_portrait', [user.id]);
    if (body.fileId) await client.query('UPDATE account_files SET is_portrait = true WHERE id = $1 AND user_id = $2', [body.fileId, user.id]);
  });
  return { status: 200, body: { portraitFileId: body.fileId } };
}));

router.delete('/account/files/:fileId', requireAuth(async ({ params, user }) => {
  const file = await ownFile(params.fileId, user.id).catch(() => null);
  if (!file) return { status: 404, body: { error: 'not found' } };
  await query('DELETE FROM account_files WHERE id = $1', [file.id]);
  try {
    await getStorage(file.storage_backend, await getStorageSettingsForUse()).remove(file.storage_key);
  } catch (err) {
    if (file.storage_backend !== 'local') {
      return { status: 502, body: { error: `Datei-Zeile gelöscht, aber Entfernen vom Speicher-Backend fehlgeschlagen: ${err.message}` } };
    }
  }
  return { status: 200, body: { deleted: true } };
}));
