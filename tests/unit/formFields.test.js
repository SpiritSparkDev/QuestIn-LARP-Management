import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderField, collectFieldValues, renderAccountFieldInput, collectAccountFieldValues, otFieldValuesEqual } from '../../frontend/js/formFields.js';

test('escapeHtml escapes the five dangerous characters', () => {
  assert.equal(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
});

test('escapeHtml treats null/undefined as an empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('renderField renders a text input with the escaped value', () => {
  const html = renderField({ key: 'fraction', label: 'Fraktion', type: 'text', required: true }, 'Nord<mark>');
  assert.ok(html.includes('name="fraction"'));
  assert.ok(html.includes('value="Nord&lt;mark&gt;"'));
  assert.ok(html.includes('required'));
});

test('renderField renders a textarea for type "textarea"', () => {
  const html = renderField({ key: 'background', label: 'Hintergrund', type: 'textarea' }, 'some <b>text</b>');
  assert.ok(html.includes('<textarea'));
  assert.ok(html.includes('some &lt;b&gt;text&lt;/b&gt;'));
});

test('renderField handles a missing value as empty', () => {
  const html = renderField({ key: 'notes', label: 'Notizen', type: 'text' }, undefined);
  assert.ok(html.includes('value=""'));
});

test('renderField escapes a field key containing a double-quote', () => {
  const html = renderField({ key: 'weird"key', label: 'Weird', type: 'text' }, 'x');
  assert.ok(!html.includes('weird"key'));
  assert.ok(html.includes('weird&quot;key'));
});

test('renderField renders a select with an option per entry and marks the current value selected', () => {
  const field = { key: 'magischBegabt', label: 'Magisch begabt', type: 'select', options: ['Arkan', 'Bardisch'] };
  const html = renderField(field, 'Bardisch');
  assert.ok(html.includes('<select'));
  assert.ok(html.includes('<option value="Arkan">Arkan</option>'));
  assert.ok(html.includes('<option value="Bardisch" selected>Bardisch</option>'));
});

test('renderField adds a blank option to an optional select with no value chosen', () => {
  const field = { key: 'magischBegabt', label: 'Magisch begabt', type: 'select', options: ['Arkan'], required: false };
  const html = renderField(field, undefined);
  assert.ok(html.includes('<option value=""></option>'));
});

test('renderField required select has no blank option', () => {
  const field = { key: 'magischBegabt', label: 'Magisch begabt', type: 'select', options: ['Arkan'], required: true };
  const html = renderField(field, undefined);
  assert.ok(!html.includes('<option value=""></option>'));
});

test('renderField escapes select option labels', () => {
  const field = { key: 'x', label: 'X', type: 'select', options: ['<b>evil</b>'] };
  const html = renderField(field, undefined);
  assert.ok(!html.includes('<b>evil</b>'));
  assert.ok(html.includes('&lt;b&gt;evil&lt;/b&gt;'));
});

test('renderField renders a checkbox for type "boolean", checked when value is true', () => {
  const html = renderField({ key: 'offenFuerAnfragen', label: 'Für Anfragen offen?', type: 'boolean' }, true);
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(html.includes('checked'));
  assert.ok(html.includes('Für Anfragen offen?'));
});

test('renderField renders an unchecked checkbox for type "boolean" when value is false or missing', () => {
  const htmlFalse = renderField({ key: 'x', label: 'X', type: 'boolean' }, false);
  assert.ok(!htmlFalse.includes('checked'));
  const htmlUndefined = renderField({ key: 'x', label: 'X', type: 'boolean' }, undefined);
  assert.ok(!htmlUndefined.includes('checked'));
});

test('renderField renders one checkbox per option for type "multiselect", checking selected values', () => {
  const field = { key: 'rollen', label: 'Rollen', type: 'multiselect', options: ['Adel', 'Bauer', 'Magier'] };
  const html = renderField(field, ['Bauer']);
  assert.ok(html.includes('value="Adel"'));
  assert.ok(html.includes('value="Bauer"'));
  assert.ok(html.includes('value="Magier"'));
  // Exactly the Bauer checkbox is checked — count "checked" occurrences.
  const checkedCount = (html.match(/checked/g) || []).length;
  assert.equal(checkedCount, 1);
});

test('renderField renders an input type="number" for type "number"', () => {
  const html = renderField({ key: 'erfahrungspunkte', label: 'Erfahrung', type: 'number' }, 42);
  assert.ok(html.includes('type="number"'));
  assert.ok(html.includes('value="42"'));
});

test('renderField renders a URL input for type "link"', () => {
  const html = renderField({ key: 'characterSheet', label: 'Charakterbogen', type: 'link' }, 'https://example.com/sheet');
  assert.ok(html.includes('type="url"'));
  assert.ok(html.includes('name="characterSheet"'));
  assert.ok(html.includes('value="https://example.com/sheet"'));
});

test('renderField renders an input type="date" for type "date"', () => {
  const html = renderField({ key: 'geburtstag', label: 'Geburtstag', type: 'date' }, '2000-01-01');
  assert.ok(html.includes('type="date"'));
  assert.ok(html.includes('value="2000-01-01"'));
  assert.ok(html.includes('name="geburtstag"'));
});

test('renderField escapes multiselect option labels', () => {
  const field = { key: 'x', label: 'X', type: 'multiselect', options: ['<b>evil</b>'] };
  const html = renderField(field, []);
  assert.ok(!html.includes('<b>evil</b>'));
  assert.ok(html.includes('&lt;b&gt;evil&lt;/b&gt;'));
});

test('collectFieldValues reads a boolean field from its checkbox state', () => {
  const form = { elements: { checked: { checked: true, type: 'checkbox' } } };
  form.querySelectorAll = undefined; // not used by the boolean path
  // collectFieldValues uses form.elements[key].checked directly for booleans —
  // simulate FormData too since the function also constructs one internally.
  // Node's built-in global FormData (undici) would otherwise throw when
  // constructed with a plain object instead of a real HTMLFormElement, so
  // the fake must unconditionally replace it (not `global.FormData || ...`,
  // which is a no-op here since Node already defines FormData globally).
  global.FormData = class {
    constructor() { this._entries = []; }
    getAll() { return []; }
    get() { return null; }
  };
  const schema = [{ key: 'checked', type: 'boolean' }];
  const result = collectFieldValues(form, schema);
  assert.equal(result.checked, true);
});

test('collectFieldValues reads a multiselect field as an array via getAll', () => {
  const entries = { rollen: ['Adel', 'Magier'] };
  const fakeFormData = { getAll: (key) => entries[key] ?? [], get: () => null };
  global.FormData = class { constructor() { return fakeFormData; } };
  const form = { elements: {} };
  const schema = [{ key: 'rollen', type: 'multiselect' }];
  const result = collectFieldValues(form, schema);
  assert.deepEqual(result.rollen, ['Adel', 'Magier']);
});

test('collectFieldValues reads a number field as a real number, or undefined when blank', () => {
  const values = { punkte: '42', leer: '' };
  const fakeFormData = { getAll: () => [], get: (key) => values[key] ?? null };
  global.FormData = class { constructor() { return fakeFormData; } };
  const form = { elements: {} };
  const schema = [
    { key: 'punkte', type: 'number' },
    { key: 'leer', type: 'number' },
  ];
  const result = collectFieldValues(form, schema);
  assert.equal(result.punkte, 42);
  assert.equal(result.leer, undefined);
});

test('collectFieldValues reads a text field as a plain string via get', () => {
  const values = { name: 'Isolde' };
  const fakeFormData = { getAll: () => [], get: (key) => values[key] ?? null };
  global.FormData = class { constructor() { return fakeFormData; } };
  const form = { elements: {} };
  const schema = [{ key: 'name', type: 'text' }];
  const result = collectFieldValues(form, schema);
  assert.equal(result.name, 'Isolde');
});

test('renderAccountFieldInput renders a checkbox for type "boolean" and a text input otherwise, both wrapped in a per-field container div', () => {
  const checkboxHtml = renderAccountFieldInput({ key: 'photoOptOut', label: 'Keine Fotoveröffentlichung', type: 'boolean' }, true);
  assert.match(checkboxHtml, /class="photoOptOut-container"/);
  assert.match(checkboxHtml, /type="checkbox"/);
  assert.match(checkboxHtml, / checked/);

  const uncheckedHtml = renderAccountFieldInput({ key: 'photoOptOut', label: 'Keine Fotoveröffentlichung', type: 'boolean' }, false);
  assert.doesNotMatch(uncheckedHtml, / checked/);

  const textHtml = renderAccountFieldInput({ key: 'address', label: 'Adresse', type: 'text' }, 'Musterstr. 1');
  assert.match(textHtml, /class="address-container"/);
  assert.match(textHtml, /type="text"/);
  assert.match(textHtml, /value="Musterstr\. 1"/);
});

test('renderAccountFieldInput supports select, number, multiselect, link, and date types like renderField', () => {
  const selectHtml = renderAccountFieldInput({ key: 'shirtSize', label: 'Shirtgröße', type: 'select', options: ['S', 'M'] }, 'M');
  assert.match(selectHtml, /<select/);
  assert.match(selectHtml, /class="shirtSize-container"/);

  const dateHtml = renderAccountFieldInput({ key: 'birthdate', label: 'Geburtsdatum', type: 'date' }, '2000-01-01');
  assert.match(dateHtml, /type="date"/);
  assert.match(dateHtml, /value="2000-01-01"/);
});

test('renderAccountFieldInput appends the sealedBadge HTML after the label text when given', () => {
  const html = renderAccountFieldInput({ key: 'address', label: 'Adresse', type: 'text' }, '', { sealedBadge: '<span class="sealed">X</span>' });
  assert.match(html, /Adresse<span class="sealed">X<\/span><\/label>/);
});

test('renderAccountFieldInput namespaces id/for with idPrefix, defaulting to unprefixed', () => {
  const plain = renderAccountFieldInput({ key: 'address', label: 'Adresse', type: 'text' }, '');
  assert.match(plain, /id="field-address"/);
  assert.match(plain, /for="field-address"/);

  const prefixed = renderAccountFieldInput({ key: 'address', label: 'Adresse', type: 'text' }, '', { idPrefix: 'edit-' });
  assert.match(prefixed, /id="edit-field-address"/);
  assert.match(prefixed, /for="edit-field-address"/);
});

test('collectAccountFieldValues reads a boolean field from a checkbox and a text field from its value', () => {
  const schema = [
    { key: 'photoOptOut', label: 'Foto', type: 'boolean' },
    { key: 'address', label: 'Adresse', type: 'text' },
  ];
  const fakeInputs = [
    { dataset: { field: 'photoOptOut' }, type: 'checkbox', checked: true },
    { dataset: { field: 'address' }, type: 'text', value: 'Musterstr. 1' },
  ];
  const fakeContainer = { querySelectorAll: () => fakeInputs };
  const result = collectAccountFieldValues(fakeContainer, schema);
  assert.deepEqual(result, { photoOptOut: true, address: 'Musterstr. 1' });
});

test('otFieldValuesEqual treats two different multiselect arrays as changed', () => {
  const field = { key: 'craftOffer', type: 'multiselect' };
  assert.equal(otFieldValuesEqual(field, ['Schmied'], ['Schneider']), false);
  assert.equal(otFieldValuesEqual(field, ['Schmied'], ['Schmied', 'Schneider']), false);
});

test('otFieldValuesEqual treats two multiselect arrays with the same values in the same order as unchanged', () => {
  const field = { key: 'craftOffer', type: 'multiselect' };
  assert.equal(otFieldValuesEqual(field, ['Schmied', 'Schneider'], ['Schmied', 'Schneider']), true);
  assert.equal(otFieldValuesEqual(field, [], []), true);
  assert.equal(otFieldValuesEqual(field, undefined, []), true);
});

test('otFieldValuesEqual treats a blank number (undefined) and the \'\' default as unchanged', () => {
  const field = { key: 'conTage', type: 'number' };
  assert.equal(otFieldValuesEqual(field, '', undefined), true);
  assert.equal(otFieldValuesEqual(field, undefined, undefined), true);
});

test('otFieldValuesEqual treats a real number change as changed', () => {
  const field = { key: 'conTage', type: 'number' };
  assert.equal(otFieldValuesEqual(field, 5, undefined), false);
  assert.equal(otFieldValuesEqual(field, 5, 6), false);
  assert.equal(otFieldValuesEqual(field, 5, 5), true);
  assert.equal(otFieldValuesEqual(field, 5, '5'), true);
});

test('otFieldValuesEqual keeps boolean and plain-string comparison behavior', () => {
  const boolField = { key: 'photoOptOut', type: 'boolean' };
  assert.equal(otFieldValuesEqual(boolField, false, undefined), true);
  assert.equal(otFieldValuesEqual(boolField, true, false), false);

  const textField = { key: 'address', type: 'text' };
  assert.equal(otFieldValuesEqual(textField, 'Musterstr. 1', 'Musterstr. 1'), true);
  assert.equal(otFieldValuesEqual(textField, 'Musterstr. 1', 'Musterstr. 2'), false);
});
