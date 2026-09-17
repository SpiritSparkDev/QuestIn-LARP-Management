import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { normalizeBooleanValue } = await import('../../db/migrateRegistrationDataBlob.js');

test('normalizeBooleanValue converts legacy free-text Ja/Nein to real booleans', () => {
  assert.equal(normalizeBooleanValue('Ja'), true);
  assert.equal(normalizeBooleanValue('Nein'), false);
});

test('normalizeBooleanValue is case-insensitive', () => {
  assert.equal(normalizeBooleanValue('ja'), true);
  assert.equal(normalizeBooleanValue('JA'), true);
  assert.equal(normalizeBooleanValue('nein'), false);
  assert.equal(normalizeBooleanValue('NEIN'), false);
});

test('normalizeBooleanValue leaves a non-matching value unchanged', () => {
  assert.equal(normalizeBooleanValue(true), true);
  assert.equal(normalizeBooleanValue(false), false);
  assert.equal(normalizeBooleanValue(''), '');
  assert.equal(normalizeBooleanValue('not a boolean'), 'not a boolean');
  assert.equal(normalizeBooleanValue(null), null);
  assert.equal(normalizeBooleanValue(undefined), undefined);
});
