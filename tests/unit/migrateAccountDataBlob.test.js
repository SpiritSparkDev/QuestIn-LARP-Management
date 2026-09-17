import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { normalizeBirthdateValue } = await import('../../db/migrateAccountDataBlob.js');

test('normalizeBirthdateValue converts a legacy German DD.MM.YYYY value to ISO YYYY-MM-DD', () => {
  assert.equal(normalizeBirthdateValue('31.12.1999'), '1999-12-31');
  assert.equal(normalizeBirthdateValue('01.01.2000'), '2000-01-01');
});

test('normalizeBirthdateValue leaves an already-ISO value unchanged', () => {
  assert.equal(normalizeBirthdateValue('1999-12-31'), '1999-12-31');
});

test('normalizeBirthdateValue leaves blank, partial, and garbage values unchanged', () => {
  assert.equal(normalizeBirthdateValue(''), '');
  assert.equal(normalizeBirthdateValue('31.12.'), '31.12.');
  assert.equal(normalizeBirthdateValue('not a date'), 'not a date');
  assert.equal(normalizeBirthdateValue(null), null);
  assert.equal(normalizeBirthdateValue(undefined), undefined);
});
