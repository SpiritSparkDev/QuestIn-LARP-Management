import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const {
  listCharacterFilesNotOnBackend,
  updateCharacterFileStorageBackend,
  getStorageUsageByBackend,
} = await import('../../backend/characterFiles/repository.js');

test('a file stamped on a non-target backend is migrated: listing stops returning it, usage totals move', async () => {
  const { rows: userRows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Bookkeeping', 'Test', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`storage-bookkeeping-${crypto.randomUUID()}@example.com`]
  );
  const { rows: charRows } = await query(
    "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'nsc', 'Bookkeeping Test Char', '{}') RETURNING id",
    [userRows[0].id]
  );
  const characterId = charRows[0].id;

  const { rows: fileRows } = await query(
    `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, storage_backend)
     VALUES (gen_random_uuid(), $1, $2, 'image', 'x.png', 'image/png', 4321, 'ftp') RETURNING id`,
    [characterId, userRows[0].id]
  );
  const fileId = fileRows[0].id;

  const beforeUsage = await getStorageUsageByBackend();
  const beforeNotOnLocal = await listCharacterFilesNotOnBackend('local');
  assert.ok(beforeNotOnLocal.some((f) => f.id === fileId));

  await updateCharacterFileStorageBackend(fileId, 'local');

  const afterNotOnLocal = await listCharacterFilesNotOnBackend('local');
  assert.ok(!afterNotOnLocal.some((f) => f.id === fileId));

  const afterUsage = await getStorageUsageByBackend();
  assert.equal(afterUsage.local, beforeUsage.local + 4321);
  assert.equal(afterUsage.ftp, beforeUsage.ftp - 4321);

  await query('DELETE FROM characters WHERE id = $1', [characterId]);
  await query('DELETE FROM users WHERE id = $1', [userRows[0].id]);
});

test.after(async () => {
  await closePool();
});
