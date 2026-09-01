import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCharacterData, validateSchemaShape } from '../../backend/events/schemaValidation.js';

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

const SELECT_SCHEMA = [
  { key: 'magischBegabt', label: 'Magisch begabt', type: 'select', required: false, options: ['Arkan', 'Bardisch', 'Klerikal'] },
];

test('a select value matching one of the allowed options is valid', () => {
  const errors = validateCharacterData(SELECT_SCHEMA, { magischBegabt: 'Bardisch' });
  assert.deepEqual(errors, []);
});

test('a select value not in the allowed options is an error', () => {
  const errors = validateCharacterData(SELECT_SCHEMA, { magischBegabt: 'Nicht-Erlaubt' });
  assert.ok(errors.some((e) => e.includes('magischBegabt')));
});

test('an empty select value is valid when the field is not required', () => {
  const errors = validateCharacterData(SELECT_SCHEMA, {});
  assert.deepEqual(errors, []);
});

const BOOLEAN_SCHEMA = [
  { key: 'offen', label: 'Offen?', type: 'boolean', required: false },
];

test('a boolean value of true or false is valid', () => {
  assert.deepEqual(validateCharacterData(BOOLEAN_SCHEMA, { offen: true }), []);
  assert.deepEqual(validateCharacterData(BOOLEAN_SCHEMA, { offen: false }), []);
});

test('a non-boolean value for a boolean field is an error', () => {
  const errors = validateCharacterData(BOOLEAN_SCHEMA, { offen: 'ja' });
  assert.ok(errors.some((e) => e.includes('offen')));
});

test('a missing boolean value is valid when the field is not required', () => {
  assert.deepEqual(validateCharacterData(BOOLEAN_SCHEMA, {}), []);
});

const MULTISELECT_SCHEMA = [
  { key: 'rollen', label: 'Rollen', type: 'multiselect', required: false, options: ['Adel', 'Bauer', 'Magier'] },
];

test('a multiselect array of allowed values is valid', () => {
  assert.deepEqual(validateCharacterData(MULTISELECT_SCHEMA, { rollen: ['Adel', 'Magier'] }), []);
});

test('a multiselect value containing something outside the options is an error', () => {
  const errors = validateCharacterData(MULTISELECT_SCHEMA, { rollen: ['Adel', 'NichtErlaubt'] });
  assert.ok(errors.some((e) => e.includes('rollen')));
});

test('a non-array multiselect value is an error', () => {
  const errors = validateCharacterData(MULTISELECT_SCHEMA, { rollen: 'Adel' });
  assert.ok(errors.some((e) => e.includes('rollen')));
});

test('an empty array for a required multiselect field is reported as missing', () => {
  const required = [{ key: 'rollen', label: 'Rollen', type: 'multiselect', required: true, options: ['Adel'] }];
  const errors = validateCharacterData(required, { rollen: [] });
  assert.ok(errors.some((e) => e.includes('rollen')));
});

const NUMBER_SCHEMA = [
  { key: 'punkte', label: 'Punkte', type: 'number', required: false },
];

test('a finite number is valid', () => {
  assert.deepEqual(validateCharacterData(NUMBER_SCHEMA, { punkte: 42 }), []);
  assert.deepEqual(validateCharacterData(NUMBER_SCHEMA, { punkte: 0 }), []);
});

test('a non-number value for a number field is an error', () => {
  const errors = validateCharacterData(NUMBER_SCHEMA, { punkte: '42' });
  assert.ok(errors.some((e) => e.includes('punkte')));
});

test('NaN or Infinity for a number field is an error', () => {
  const errorsNaN = validateCharacterData(NUMBER_SCHEMA, { punkte: NaN });
  assert.ok(errorsNaN.some((e) => e.includes('punkte')));
  const errorsInf = validateCharacterData(NUMBER_SCHEMA, { punkte: Infinity });
  assert.ok(errorsInf.some((e) => e.includes('punkte')));
});

test('validateCharacterData rejects a link value that does not start with http:// or https://', () => {
  const schema = [{ key: 'sheet', label: 'Sheet', type: 'link' }];
  const errors = validateCharacterData(schema, { sheet: 'not-a-url' });
  assert.ok(errors.some((e) => e.includes('sheet')));
});

test('validateCharacterData accepts a well-formed https link', () => {
  const schema = [{ key: 'sheet', label: 'Sheet', type: 'link' }];
  const errors = validateCharacterData(schema, { sheet: 'https://example.com/sheet' });
  assert.deepEqual(errors, []);
});

test('validateSchemaShape accepts a well-formed schema', () => {
  assert.equal(validateSchemaShape([
    { key: 'klasse', label: 'Klasse', type: 'text' },
    { key: 'volk', label: 'Volk', type: 'text' },
  ]), true);
});

test('validateSchemaShape accepts an empty schema', () => {
  assert.equal(validateSchemaShape([]), true);
});

test('validateSchemaShape rejects a non-array', () => {
  assert.equal(validateSchemaShape({ key: 'x' }), false);
  assert.equal(validateSchemaShape(null), false);
  assert.equal(validateSchemaShape('x'), false);
});

test('validateSchemaShape rejects a field with a missing or empty key', () => {
  assert.equal(validateSchemaShape([{ label: 'No key', type: 'text' }]), false);
  assert.equal(validateSchemaShape([{ key: '', label: 'Empty key', type: 'text' }]), false);
});

test('validateSchemaShape rejects the reserved keys "id" and "name"', () => {
  assert.equal(validateSchemaShape([{ key: 'id', label: 'Id', type: 'text' }]), false);
  assert.equal(validateSchemaShape([{ key: 'name', label: 'Name', type: 'text' }]), false);
  assert.equal(validateSchemaShape([{ key: 'klasse', label: 'Klasse', type: 'text' }, { key: 'id', label: 'Id', type: 'text' }]), false);
});

test('validateSchemaShape rejects the reserved key "eventId"', () => {
  assert.equal(validateSchemaShape([{ key: 'eventId', label: 'Event Id', type: 'text' }]), false);
});

test('validateSchemaShape rejects duplicate keys within one schema', () => {
  assert.equal(validateSchemaShape([
    { key: 'klasse', label: 'Klasse', type: 'text' },
    { key: 'klasse', label: 'Klasse (2)', type: 'text' },
  ]), false);
});
