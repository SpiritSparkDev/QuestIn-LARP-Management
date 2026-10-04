import { query } from '../db.js';

const SELECT_COLUMNS = 'id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, is_public, storage_backend, storage_key, created_at';

// Where a file's bytes live in the storage backend: its own character folder
// for new uploads, the legacy flat id for files uploaded before folders.
export function storageKeyFor(file) {
  return file.storage_key ?? file.id;
}

export function newStorageKey(characterId, fileId) {
  return `${characterId}/${fileId}`;
}

export async function createCharacterFile({ id, characterId, uploadedBy, kind, originalFilename, mimeType, sizeBytes, isPublic, storageBackend, storageKey = null }) {
  const { rows } = await query(
    `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, is_public, storage_backend, storage_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SELECT_COLUMNS}`,
    [id, characterId, uploadedBy, kind, originalFilename, mimeType, sizeBytes, isPublic, storageBackend, storageKey]
  );
  return rows[0];
}

export async function getCharacterFile(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM character_files WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listCharacterFiles(characterId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM character_files WHERE character_id = $1 ORDER BY created_at`,
    [characterId]
  );
  return rows;
}

export async function getCharacterFilesTotalSize(characterId) {
  const { rows } = await query(
    'SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total FROM character_files WHERE character_id = $1',
    [characterId]
  );
  return Number(rows[0].total);
}

export async function deleteCharacterFile(id) {
  const { rows } = await query('DELETE FROM character_files WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

export async function getStorageUsageByBackend() {
  const { rows } = await query(
    "SELECT storage_backend, COALESCE(SUM(size_bytes), 0)::bigint AS total FROM character_files GROUP BY storage_backend"
  );
  const usage = { local: 0, ftp: 0, s3: 0 };
  for (const row of rows) usage[row.storage_backend] = Number(row.total);
  return usage;
}

export async function listCharacterFilesNotOnBackend(backend) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM character_files WHERE storage_backend != $1`, [backend]);
  return rows;
}

export async function updateCharacterFileStorageBackend(id, backend, storageKey) {
  await query('UPDATE character_files SET storage_backend = $2, storage_key = $3 WHERE id = $1', [id, backend, storageKey]);
}
