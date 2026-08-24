import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { query, closePool } = await import('../../backend/db.js');

test('query executes against the test database', async () => {
  const result = await query('SELECT 1 + 1 AS sum');
  assert.equal(result.rows[0].sum, 2);
});

test.after(async () => {
  await closePool();
});
