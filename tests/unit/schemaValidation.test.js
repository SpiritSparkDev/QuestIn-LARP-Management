import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCharacterData } from '../../backend/events/schemaValidation.js';

const SCHEMA = [
  { key: 'fraction', label: 'Fraktion', type: 'text', required: true },
  { key: 'background', label: 'Hintergrund', type: 'textarea', required: false },
];

test('valid data passes with no errors', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: 'Nordmark', background: 'Ein Waisenkind' });
  assert.deepEqual(errors, []);
});

test('a missing required field is an error', () => {
  const errors = validateCharacterData(SCHEMA, { background: 'nur Hintergrund' });
  assert.ok(errors.some((e) => e.includes('fraction')));
});

test('an unknown field is an error', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: 'Nordmark', notInSchema: 'x' });
  assert.ok(errors.some((e) => e.includes('notInSchema')));
});

test('an empty schema with empty data is valid', () => {
  assert.deepEqual(validateCharacterData([], {}), []);
});

test('an empty string for a required field is an error', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: '' });
  assert.ok(errors.some((e) => e.includes('fraction')));
});

test('a required field named after an inherited Object.prototype key is still reported as missing', () => {
  const schema = [{ key: 'toString', label: 'toString', type: 'text', required: true }];
  const errors = validateCharacterData(schema, {});
  assert.ok(errors.some((e) => e.includes('toString')));
});

test('a text field given a non-string value is an error', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: 42 });
  assert.ok(errors.some((e) => e.includes('fraction')));

  const errors2 = validateCharacterData(SCHEMA, { fraction: { nested: true } });
  assert.ok(errors2.some((e) => e.includes('fraction')));
});

test('a value longer than the max length is an error', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: 'x'.repeat(5001) });
  assert.ok(errors.some((e) => e.includes('fraction')));
});

test('a whitespace-only string for a required field is still reported as missing', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: '   ' });
  assert.ok(errors.some((e) => e.includes('fraction')));
});
