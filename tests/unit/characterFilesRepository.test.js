import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { query, closePool } = await import('../../backend/db.js');
const { getCharacterFilesTotalSize } = await import('../../backend/characterFiles/repository.js');

test('getCharacterFilesTotalSize returns 0, not null, for a character with no files', async () => {
  const total = await getCharacterFilesTotalSize('00000000-0000-0000-0000-000000000000');
  assert.equal(total, 0);
});

test.after(async () => {
  await query('SELECT 1'); // keep the pool warm until here, then close
  await closePool();
});
