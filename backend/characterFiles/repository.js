import { query } from '../db.js';

const SELECT_COLUMNS = 'id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, is_public, created_at';

export async function createCharacterFile({ id, characterId, uploadedBy, kind, originalFilename, mimeType, sizeBytes, isPublic }) {
  const { rows } = await query(
    `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, is_public)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SELECT_COLUMNS}`,
    [id, characterId, uploadedBy, kind, originalFilename, mimeType, sizeBytes, isPublic]
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
