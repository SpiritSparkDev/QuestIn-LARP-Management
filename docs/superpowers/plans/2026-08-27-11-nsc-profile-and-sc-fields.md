# NSC Profile & SC Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give NSC-group users their own global profile form (decoupled from events/characters), extend the default SC character schema with the fields the scene actually uses, add a `Pronomen` account field, and close a real gap the previous plan's final review found (member detail view missing read-only fields, character list, and group reassignment).

**Architecture:** Three new generic field types (`boolean`, `multiselect`, `number`) extend the existing `formFields.js`/`schemaValidation.js` pair so character schemas AND the new NSC profile schema share one rendering/validation pipeline, no duplication. NSC profile schema is a single-row table (`nsc_profile_schema`), same seed-script pattern as `groups`. `Pronomen` follows the exact existing encrypted-account-field pattern (`address`, `phone`, etc.) end to end — `users`, `invitations`, account repository, groups' `account_fields` vocabulary.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step.

**Spec:** `docs/superpowers/specs/2026-08-27-sc-nsc-profilfelder-design.md` (extends `docs/superpowers/specs/2026-08-24-teilnehmerregistrierung-design.md` and `docs/superpowers/specs/2026-08-26-gruppen-berechtigungen-design.md`)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- **The LAST task must run the full `npm test` suite as an explicit step** — this is now a standing rule for every plan in this sequence (see project memory: a prior plan shipped a real bug specifically because no task ever ran the full suite).
- No separate "Alter" (age) field — `birthdate` already covers it, per the spec's explicit ruling.
- No feature-set changes for GSC/SC beyond the schema additions specified here — only NSC gets a global profile form.
- Every existing test must still pass; verify with each task's specified scope before the final full-suite gate.
- Verify visually via Claude Browser tools against the running dev stack for every page you touch.

---

### Task 1: New field types — `boolean`, `multiselect`, `number`

**Files:**
- Modify: `frontend/js/formFields.js`
- Modify: `backend/events/schemaValidation.js`
- Modify: `frontend/characters.html` (fix the dynamic-schema form submission to use the new field-collection helper — see below, this is a real correctness gap the new types would otherwise open)
- Modify: `tests/unit/formFields.test.js`
- Modify: `tests/unit/schemaValidation.test.js`

**Interfaces:**
- Produces: `renderField(field, value)` (extended, same signature) and a NEW `export function collectFieldValues(form, schema)` from `frontend/js/formFields.js` — reads a schema-driven form's current values back into a plain object, correctly handling multi-checkbox `multiselect` fields (which `Object.fromEntries(new FormData(form))` cannot, since it silently keeps only the last of several same-named entries) and boolean checkboxes (which are absent from `FormData` entirely when unchecked). Consumed by this task's own `characters.html` fix and by Task 4's new NSC section on `account.html`.
- Produces: `validateCharacterData(schema, data)` (extended, same signature) from `backend/events/schemaValidation.js` — now also validates `boolean`/`multiselect`/`number` typed fields. Consumed by every existing character-schema caller (unchanged call sites) and by Task 2's new NSC-schema validation.

- [ ] **Step 1: Write the failing tests for `formFields.js`**

Add to `tests/unit/formFields.test.js` (after the existing tests, before the final closing — just append):

```javascript
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
  global.FormData = global.FormData || class {
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/formFields.test.js`
Expected: FAIL — `renderField` doesn't handle `boolean`/`multiselect`/`number` yet, and `collectFieldValues` isn't exported at all (`TypeError: collectFieldValues is not a function` or similar).

- [ ] **Step 3: Extend `frontend/js/formFields.js`**

Replace the entire file with:

```javascript
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function renderField(field, value) {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key);
  const key = escapeHtml(field.key);
  const required = field.required ? 'required' : '';
  const id = `field-${key}`;

  if (field.type === 'boolean') {
    const checked = value ? ' checked' : '';
    return `<label for="${id}"><input id="${id}" name="${key}" type="checkbox"${checked}> ${label}</label>`;
  }
  if (field.type === 'multiselect' && Array.isArray(field.options)) {
    const selected = Array.isArray(value) ? value : [];
    const checkboxes = field.options.map((opt, i) => {
      const escapedOpt = escapeHtml(opt);
      const checked = selected.includes(opt) ? ' checked' : '';
      return `<label for="${id}-${i}"><input id="${id}-${i}" name="${key}" type="checkbox" value="${escapedOpt}"${checked}> ${escapedOpt}</label>`;
    }).join('');
    return `<span>${label}</span>${checkboxes}`;
  }
  if (field.type === 'number') {
    return `<label for="${id}">${label}</label><input id="${id}" name="${key}" type="number" value="${val}" ${required}>`;
  }
  if (field.type === 'textarea') {
    return `<label for="${id}">${label}</label><textarea id="${id}" name="${key}" ${required}>${val}</textarea>`;
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    const blankOption = field.required ? '' : '<option value=""></option>';
    const options = field.options.map((opt) => {
      const escapedOpt = escapeHtml(opt);
      const selected = opt === value ? ' selected' : '';
      return `<option value="${escapedOpt}"${selected}>${escapedOpt}</option>`;
    }).join('');
    return `<label for="${id}">${label}</label><select id="${id}" name="${key}" ${required}>${blankOption}${options}</select>`;
  }
  return `<label for="${id}">${label}</label><input id="${id}" name="${key}" type="text" value="${val}" ${required}>`;
}

// Reads a schema-driven form's current values back into a plain object.
// Object.fromEntries(new FormData(form)) is NOT enough for schema-driven
// forms: it silently keeps only the LAST of several same-named entries
// (breaking multiselect, which renders one checkbox per option under the
// same name) and it can't distinguish "field absent from schema" from
// "checkbox unchecked" for booleans. This walks the schema explicitly
// instead of the form's raw entries.
export function collectFieldValues(form, schema) {
  const formData = new FormData(form);
  const result = {};
  for (const field of schema) {
    if (field.type === 'boolean') {
      result[field.key] = form.elements[field.key]?.checked ?? false;
    } else if (field.type === 'multiselect') {
      result[field.key] = formData.getAll(field.key);
    } else if (field.type === 'number') {
      const raw = formData.get(field.key);
      result[field.key] = raw === '' || raw === null ? undefined : Number(raw);
    } else {
      result[field.key] = formData.get(field.key) ?? '';
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/formFields.test.js`
Expected: all tests PASS (existing + new).

- [ ] **Step 5: Write the failing tests for `schemaValidation.js`**

Add to `tests/unit/schemaValidation.test.js` (append, after the existing tests):

```javascript
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
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test tests/unit/schemaValidation.test.js`
Expected: FAIL — `boolean`/`multiselect`/`number` types aren't validated yet (a `boolean` field given a string would currently pass silently, since no type check exists for it).

- [ ] **Step 7: Extend `backend/events/schemaValidation.js`**

Replace the entire file with:

```javascript
const MAX_VALUE_LENGTH = 5000;
const MAX_TOTAL_LENGTH = 20000;

export function validateCharacterData(schema, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['data must be an object'];
  }

  const errors = [];
  const allowedKeys = new Set(schema.map((field) => field.key));

  for (const field of schema) {
    const value = Object.hasOwn(data, field.key) ? data[field.key] : undefined;
    const isEmpty = value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '')
      || (Array.isArray(value) && value.length === 0);

    if (field.required && isEmpty) {
      errors.push(`${field.key} is required`);
      continue;
    }
    if (!isEmpty && (field.type === 'text' || field.type === 'textarea') && typeof value !== 'string') {
      errors.push(`${field.key} must be a string`);
    }
    if (!isEmpty && field.type === 'select' && Array.isArray(field.options) && !field.options.includes(value)) {
      errors.push(`${field.key} must be one of: ${field.options.join(', ')}`);
    }
    if (!isEmpty && field.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${field.key} must be a boolean`);
    }
    if (!isEmpty && field.type === 'multiselect') {
      const optionsOk = Array.isArray(field.options);
      if (!Array.isArray(value) || !optionsOk || !value.every((v) => field.options.includes(v))) {
        errors.push(`${field.key} must be an array of: ${optionsOk ? field.options.join(', ') : ''}`);
      }
    }
    if (!isEmpty && field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${field.key} must be a number`);
    }
    if (!isEmpty && typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
      errors.push(`${field.key} must be at most ${MAX_VALUE_LENGTH} characters`);
    }
  }

  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  if (JSON.stringify(data).length > MAX_TOTAL_LENGTH) {
    errors.push(`data must be at most ${MAX_TOTAL_LENGTH} characters when serialized`);
  }

  return errors;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/unit/schemaValidation.test.js`
Expected: all tests PASS (existing + new).

- [ ] **Step 9: Fix `characters.html`'s dynamic-field form submission**

The existing submit handler reads dynamic schema-field values via `Object.fromEntries(new FormData(form))`, which silently mishandles the new `multiselect`/`boolean` types (see this task's Interfaces note). Find the `form.addEventListener('submit', async (event) => { ... })` block and change:

```javascript
  const formData = new FormData(form);
  const { eventId, name, ...rest } = Object.fromEntries(formData);
```

to:

```javascript
  const eventId = eventSelect.value;
  const name = form.elements.name.value;
  const schema = events.find((e) => e.id === eventId)?.character_form_schema ?? [];
  const rest = collectFieldValues(form, schema);
```

and add `collectFieldValues` to the existing import line near the top of the script:

```javascript
import { escapeHtml, renderField, collectFieldValues } from '/js/formFields.js';
```

(`events.find((e) => e.id === eventId)` correctly resolves the right schema in both the create and edit paths — `eventSelect.value` is set to `character.event_id` by `startEdit` even while the select is disabled, so this one expression works for both.)

- [ ] **Step 10: Verify visually**

Using Claude Browser tools against the running dev stack: log in as a participant (or admin), go to `/characters.html`, create/edit a character on an event using the DEFAULT_CHARACTER_SCHEMA's existing `select` field (`magischBegabt`) to confirm nothing regressed. New field types aren't reachable yet through the UI (no event uses them until Task 2 loads a template, and events' schema builder itself isn't changed by this task) — this step is a regression check only, not new-feature verification.

- [ ] **Step 11: Run the unit test suite**

Run: `node --test tests/unit/*.test.js`
Expected: all pass (confirms nothing else broke).

- [ ] **Step 12: Commit**

```bash
git add frontend/js/formFields.js backend/events/schemaValidation.js frontend/characters.html tests/unit/formFields.test.js tests/unit/schemaValidation.test.js
git commit -m "feat: add boolean/multiselect/number field types shared by character and NSC schemas"
```

---

### Task 2: SC schema extension + NSC profile schema backend

**Files:**
- Modify: `frontend/js/defaultCharacterSchema.js`
- Create: `db/migrations/008_nsc_profile_schema.sql`
- Create: `config/nscProfileDefaults.js`
- Create: `db/seedNscProfileSchema.js`
- Create: `backend/nscSchema/routes.js`
- Modify: `backend/server.js`
- Modify: `package.json` (add `seed-nsc-schema` script)
- Modify: `docker-compose.yml` (wire the new seed step into the app startup chain)
- Create: `tests/integration/nscSchema.test.js`
- Modify: `tests/integration/schema-users.test.js` (add `nsc_profile_schema` table-existence check)

**Interfaces:**
- Consumes: Task 1's `boolean`/`multiselect`/`number` field types (used by the NSC default schema) and `validateCharacterData` (reused, unchanged signature, for NSC data validation).
- Produces: `GET /nsc-schema` (readable by `admin` or a user whose own `group.key === 'nsc'`), `PUT /nsc-schema` (admin-only). Consumed by Task 4's `PATCH /account` extension and the NSC section on `account.html`.

- [ ] **Step 1: Extend `frontend/js/defaultCharacterSchema.js`**

Add the 7 new fields to the existing array (keep all 5 existing entries exactly as they are, append after `conTage`):

```javascript
export const DEFAULT_CHARACTER_SCHEMA = [
  { key: 'klasse', label: 'Klasse', type: 'text', required: true },
  { key: 'volk', label: 'Volk', type: 'text', required: true },
  { key: 'religion', label: 'Religion', type: 'text', required: false },
  {
    key: 'magischBegabt',
    label: 'Magisch begabt',
    type: 'select',
    required: false,
    options: ['Arkan', 'Bardisch', 'Klerikal', 'Natur', 'Dämonisch', 'Anderes'],
  },
  { key: 'conTage', label: 'Con-Tage des Charakters', type: 'text', required: false },
  { key: 'titel', label: 'Titel', type: 'text', required: false },
  { key: 'gesinnung', label: 'Gesinnung', type: 'text', required: false },
  { key: 'heimatland', label: 'Heimatland', type: 'text', required: false },
  { key: 'erfahrungspunkte', label: 'Erfahrung (Punkte)', type: 'number', required: false },
  { key: 'charakterVorlieben', label: 'Charakter-Gerne', type: 'textarea', required: false },
  { key: 'charaktergeschichte', label: 'Charaktergeschichte/Wissenswertes', type: 'textarea', required: false },
  { key: 'konfliktpotenzial', label: 'Konfliktpotenzial', type: 'textarea', required: false },
];
```

- [ ] **Step 2: Write the migration**

Create `db/migrations/008_nsc_profile_schema.sql`:

```sql
CREATE TABLE nsc_profile_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

ALTER TABLE users ADD COLUMN nsc_data jsonb NOT NULL DEFAULT '{}';
```

- [ ] **Step 3: Write `config/nscProfileDefaults.js`**

```javascript
export const NSC_PROFILE_SCHEMA_DEFAULTS = [
  { key: 'fuerOrgaanfragenOffen', label: 'Für Orgaanfragen offen?', type: 'boolean', required: false },
  { key: 'alsHilfsSlVerfuegbar', label: 'Als Hilfs-SL verfügbar?', type: 'boolean', required: false },
  { key: 'erfahrung', label: 'Erfahrung', type: 'select', required: false, options: ['Anfänger', 'Fortgeschritten', 'Erfahren'] },
  { key: 'rollenbindung', label: 'Rollenbindung', type: 'select', required: false, options: ['Springer', 'Mittel', 'Festrolle'] },
  { key: 'anfuehrerfaehigkeiten', label: 'Anführerfähigkeiten', type: 'select', required: false, options: ['Untergebener', 'Mitläufer', 'Anführer'] },
  { key: 'sprechrollen', label: 'Sprechrollen', type: 'select', required: false, options: ['Still', 'Wenige Sätze', 'Redner'] },
  { key: 'schauspieltalent', label: 'Schauspieltalent', type: 'select', required: false, options: ['Statist', 'Mittel', 'Schauspieler'] },
  { key: 'kampferfahrung', label: 'Kampferfahrung', type: 'select', required: false, options: ['Pazifist', 'Mittel', 'Veteran'] },
  { key: 'equipment', label: 'Equipment', type: 'select', required: false, options: ['Wenig', 'Mittel', 'Viel'] },
  { key: 'improvisationsfaehigkeit', label: 'Improvisationsfähigkeit', type: 'select', required: false, options: ['Weisungsgebunden', 'Mittel', 'Improvisationstalent'] },
  { key: 'sozialverhalten', label: 'Sozialverhalten', type: 'select', required: false, options: ['Schüchtern', 'Mittel', 'Offenherzig'] },
  { key: 'belastbarkeit', label: 'Belastbarkeit', type: 'select', required: false, options: ['Wenig', 'Mittel', 'Viel'] },
  {
    key: 'rollenAusruestung', label: 'Ausrüstung/Vorliebe für Darstellung als', type: 'multiselect', required: false,
    options: [
      'Adel', 'Alchemist', 'Bauer', 'Handwerker', 'Dämon', 'Fay', 'Druide', 'Elf', 'Geist',
      'Gelehrter', 'Herold', 'Hexe', 'Kämpfer (leicht)', 'Kämpfer (Kettenhemd/Mittel)',
      'Kämpfer (Platte)', 'Magier', 'Priester', 'Räuber/Bandit', 'Schamane', 'Fahrendes Volk',
      'Kaufmann', 'Untoter (Höherer)', 'Untoter (Niederer)', 'Waldläufer',
    ],
  },
  { key: 'darstellungsstaerken', label: 'Was kann ich gut darstellen?', type: 'textarea', required: false },
  { key: 'einsatzwuensche', label: 'Womit kann man mich beauftragen?', type: 'textarea', required: false },
];
```

- [ ] **Step 4: Write `db/seedNscProfileSchema.js`**

Mirrors `db/seedGroups.js`'s idempotent pattern (a single-row table, insert only if empty):

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { NSC_PROFILE_SCHEMA_DEFAULTS } from '../config/nscProfileDefaults.js';

export async function seedNscProfileSchema() {
  const { rows } = await query('SELECT id FROM nsc_profile_schema LIMIT 1');
  if (rows.length > 0) {
    logger.info('nsc profile schema seed skipped: row already exists');
    return;
  }
  await query('INSERT INTO nsc_profile_schema (schema) VALUES ($1)', [JSON.stringify(NSC_PROFILE_SCHEMA_DEFAULTS)]);
  logger.info('nsc profile schema seeded');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  seedNscProfileSchema()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('nsc profile schema seed failed', { error: err.message });
      process.exit(1);
    });
}
```

- [ ] **Step 5: Write `backend/nscSchema/routes.js`**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { query } from '../db.js';

function isValidSchemaShape(schema) {
  return Array.isArray(schema) && schema.every(
    (field) => field && typeof field === 'object' && typeof field.key === 'string' && field.key.length > 0
  );
}

router.get('/nsc-schema', requireAuth(async ({ user }) => {
  if (user.group.key !== 'admin' && user.group.key !== 'nsc') {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const { rows } = await query('SELECT schema FROM nsc_profile_schema LIMIT 1');
  return { status: 200, body: rows[0]?.schema ?? [] };
}));

router.put('/nsc-schema', requireAuth(async ({ req, user }) => {
  if (user.group.key !== 'admin') {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!isValidSchemaShape(schema)) {
    return { status: 400, body: { error: 'schema must be an array of objects each with a string "key"' } };
  }
  const { rows } = await query('SELECT id FROM nsc_profile_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO nsc_profile_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE nsc_profile_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return { status: 200, body: schema };
}));
```

(Mirrors the existing event-schema shape check used in `backend/events/routes.js`'s `isValidCharacterFormSchema` — same lightweight structural validation, not full field-type validation, since the schema itself defines what "valid data" means for later `validateCharacterData` calls, not the other way around.)

- [ ] **Step 6: Register the route module and seed script**

In `backend/server.js`, add alongside the other route-module imports (after `import './members/routes.js';`):

```javascript
import './nscSchema/routes.js';
```

In `package.json`, add after `"seed-groups": "node db/seedGroups.js",`:

```json
    "seed-nsc-schema": "node db/seedNscProfileSchema.js",
```

In `docker-compose.yml`, update the `app` service's `command` to run the new seed step after `seed-groups` and before `seed-admin` (order doesn't strictly matter relative to `seed-admin`, but keep all seed steps grouped together after migrate):

```yaml
    command: sh -c "npm run migrate && npm run seed-groups && npm run seed-nsc-schema && npm run seed-admin && npm run dev"
```

- [ ] **Step 7: Write the failing tests first**

Create `tests/integration/nscSchema.test.js` (mirror `tests/integration/groups.test.js`'s structure and conventions):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { seedNscProfileSchema } = await import('../../db/seedNscProfileSchema.js');
await seedNscProfileSchema();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createServer } = await import('../../backend/server.js');

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'NSC Schema Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`nsc-schema-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /nsc-schema rejects a group that is neither admin nor nsc', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/nsc-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('GET /nsc-schema is reachable by an nsc-group user and returns the seeded default fields', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('nsc');
    const res = await fetch(`http://localhost:${port}/nsc-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const schema = await res.json();
    assert.ok(schema.some((f) => f.key === 'fuerOrgaanfragenOffen'));
    assert.ok(schema.some((f) => f.key === 'rollenAusruestung' && f.type === 'multiselect'));
  } finally {
    server.close();
  }
});

test('PUT /nsc-schema rejects a non-admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('nsc');
    const res = await fetch(`http://localhost:${port}/nsc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [] }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('PUT /nsc-schema updates the schema for an admin caller', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const newSchema = [{ key: 'test', label: 'Test', type: 'text' }];
    const putRes = await fetch(`http://localhost:${port}/nsc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: newSchema }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`http://localhost:${port}/nsc-schema`, { headers: { Cookie: cookie } });
    const schema = await getRes.json();
    assert.deepEqual(schema, newSchema);

    // Restore the real defaults so later tests/manual verification in this
    // shared DB aren't left with a one-field test schema.
    const { NSC_PROFILE_SCHEMA_DEFAULTS } = await import('../../config/nscProfileDefaults.js');
    await fetch(`http://localhost:${port}/nsc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: NSC_PROFILE_SCHEMA_DEFAULTS }),
    });
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'nsc-schema-%'");
  await closePool();
});
```

- [ ] **Step 8: Run the tests**

Run: `node --test tests/integration/nscSchema.test.js`
Expected: all 4 tests PASS.

- [ ] **Step 9: Add the `nsc_profile_schema` table check**

In `tests/integration/schema-users.test.js`, find the table-existence loop (extended in an earlier plan to include `'groups'`) and add `'nsc_profile_schema'`:

```javascript
  for (const table of ['users', 'sessions', 'email_verification_tokens', 'password_reset_tokens', 'groups', 'nsc_profile_schema']) {
```

- [ ] **Step 10: Run that test**

Run: `node --test tests/integration/schema-users.test.js`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add frontend/js/defaultCharacterSchema.js db/migrations/008_nsc_profile_schema.sql config/nscProfileDefaults.js db/seedNscProfileSchema.js backend/nscSchema/routes.js backend/server.js package.json docker-compose.yml tests/integration/nscSchema.test.js tests/integration/schema-users.test.js
git commit -m "feat: add NSC profile schema backend and extend the default SC character schema"
```

---

### Task 3: `Pronomen` account field

**Files:**
- Create: `db/migrations/009_pronomen_field.sql`
- Create: `backend/accountFields.js`
- Modify: `backend/groups/routes.js` (use the new shared constant instead of its own inline copy)
- Modify: `backend/members/routes.js` (same)
- Modify: `backend/accounts/repository.js`
- Modify: `backend/invitations/repository.js`
- Modify: `backend/members/repository.js`
- Modify: `frontend/account.html`
- Modify: `frontend/admin/groups.html`
- Modify: `frontend/admin/members.html`
- Modify: `tests/integration/accounts.test.js`
- Modify: `tests/integration/schema-users.test.js`

**Interfaces:**
- Produces: `export const ACCOUNT_FIELD_KEYS` from `backend/accountFields.js` — the single source of truth for the account-field vocabulary, now `['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen', 'group']`. Replaces the two independently-maintained inline copies in `backend/groups/routes.js` and `backend/members/routes.js` (a duplication already flagged as a maintenance risk by the previous plan's final review — this task is exactly the situation that risk was about, so fixing it now is in scope, not a detour).

- [ ] **Step 1: Write the migration**

Create `db/migrations/009_pronomen_field.sql`. This both adds the new encrypted columns AND grants the `admin`/`orga` groups the new permission on their EXISTING rows — adding `'pronomen'` to `db/groupDefaults.js` alone would only affect a brand-new database's first seed run (`db/seedGroups.js` uses `ON CONFLICT (key) DO NOTHING`, so it never touches an already-seeded row); a real migration is the only way to grant this on a database that's already past its first seed, including this project's own dev database:

```sql
ALTER TABLE users ADD COLUMN pronomen_enc bytea;
ALTER TABLE invitations ADD COLUMN pronomen_enc bytea;

UPDATE groups SET account_fields = account_fields || '["pronomen"]'::jsonb
WHERE key IN ('admin', 'orga') AND NOT (account_fields @> '["pronomen"]'::jsonb);
```

(The `NOT (account_fields @> ...)` guard makes this UPDATE safe to reason about even though migrations only ever run once per database via `schema_migrations` — no harm in the belt-and-braces check, and it documents the intent clearly.)

- [ ] **Step 2: Write `backend/accountFields.js`**

```javascript
export const ACCOUNT_FIELD_KEYS = ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen', 'group'];
```

- [ ] **Step 3: Use the shared constant in `backend/groups/routes.js`**

Remove the inline `const ACCOUNT_FIELD_KEYS = [...]` line and replace it with an import:

```javascript
import { ACCOUNT_FIELD_KEYS } from '../accountFields.js';
```

(Add this import alongside the other imports at the top of the file; delete the old inline `const ACCOUNT_FIELD_KEYS = ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'group'];` line entirely — don't leave both.)

- [ ] **Step 4: Use the shared constant in `backend/members/routes.js`**

Same change: remove the inline `const ACCOUNT_FIELD_KEYS = [...]` line, add `import { ACCOUNT_FIELD_KEYS } from '../accountFields.js';` alongside the other imports.

- [ ] **Step 5: Extend `backend/accounts/repository.js`**

Add `pronomen` to `decryptAccount`'s return, `SELECT_COLUMNS`, and `updateAccount`'s SET clause + params, following the exact existing pattern for `phone`:

```javascript
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    group: { key: row.group_key, name: row.group_name },
    menus: row.visible_menus,
    canEditCharacters: row.can_edit_characters,
    accountFields: row.account_fields,
    emailVerified: row.email_verified,
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
    pronomen: decryptField(row.pronomen_enc),
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc, users.pronomen_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields
`;

const FROM_JOIN = `FROM users JOIN groups ON groups.id = users.group_id`;

export async function getAccount(userId) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE users.id = $1`, [userId]);
  if (rows.length === 0) return null;
  return decryptAccount(rows[0]);
}

export async function updateAccount(userId, fields) {
  const { rows } = await query(
    `UPDATE users SET
       name = COALESCE($2, name),
       address_enc = COALESCE($3, address_enc),
       birthdate_enc = COALESCE($4, birthdate_enc),
       phone_enc = COALESCE($5, phone_enc),
       emergency_contact_enc = COALESCE($6, emergency_contact_enc),
       medical_notes_enc = COALESCE($7, medical_notes_enc),
       pronomen_enc = COALESCE($8, pronomen_enc)
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.name ?? null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContact !== undefined ? encryptField(fields.emergencyContact) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
      fields.pronomen !== undefined ? encryptField(fields.pronomen) : null,
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}
```

- [ ] **Step 6: Extend `backend/invitations/repository.js`**

Add `pronomen` following the exact existing pattern for `medicalNotes` — in `decryptInvitation`, `SELECT_COLUMNS`, `createInvitation`'s destructured params and INSERT:

Change `SELECT_COLUMNS`:
```javascript
const SELECT_COLUMNS = `
  id, token, email, name, group_id,
  address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, pronomen_enc,
  invited_by, expires_at, created_at, redeemed_at
`;
```

Add to `decryptInvitation`'s return object (after `medicalNotes`):
```javascript
    pronomen: decryptField(row.pronomen_enc),
```

Change `createInvitation`'s signature and body:
```javascript
export async function createInvitation({ email, name, groupId, invitedBy, address, birthdate, phone, emergencyContact, medicalNotes, pronomen }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const { rows } = await query(
    `INSERT INTO invitations (token, email, name, group_id, address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, pronomen_enc, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${SELECT_COLUMNS}`,
    [
      token, email, name, groupId,
      address !== undefined ? encryptField(address) : null,
      birthdate !== undefined ? encryptField(birthdate) : null,
      phone !== undefined ? encryptField(phone) : null,
      emergencyContact !== undefined ? encryptField(emergencyContact) : null,
      medicalNotes !== undefined ? encryptField(medicalNotes) : null,
      pronomen !== undefined ? encryptField(pronomen) : null,
      invitedBy, expiresAt,
    ]
  );
  return decryptInvitation(rows[0]);
}
```

- [ ] **Step 7: Update `backend/members/routes.js`'s invite handler to pass through `pronomen`**

In the `POST /members/invite` handler, the `createInvitation` call currently lists each account field explicitly (from the previous plan's final hardening fix — an intentional explicit allowlist, not a spread). Add `pronomen` to that same explicit list:

```javascript
  const invitation = await createInvitation({
    email: email.toLowerCase(),
    name,
    groupId: groupRows[0].id,
    invitedBy: user.id,
    address: rest.address,
    birthdate: rest.birthdate,
    phone: rest.phone,
    emergencyContact: rest.emergencyContact,
    medicalNotes: rest.medicalNotes,
    pronomen: rest.pronomen,
  });
```

- [ ] **Step 8: Extend `backend/members/repository.js`**

`getMember`/`listMembers`/`updateMember` follow the same field list as `accounts/repository.js` — add `pronomen` in the equivalent 3 places (`SELECT_COLUMNS`, `decryptMember`'s return, `updateMember`'s SET clause + params), mirroring exactly what Step 5 did for `accounts/repository.js`. Read the current file first to match its exact existing structure before editing.

- [ ] **Step 9: Add the Pronomen field to `frontend/account.html`**

Add a new field between `medicalNotes` and the submit button (or wherever fits the existing field order — the spec doesn't mandate a specific position):

```html
      <label for="pronomen">Pronomen <span class="sealed">Verschlüsselt</span></label>
      <input id="pronomen" name="pronomen" type="text">
```

And add `'pronomen'` to the script's field-loading loop:
```javascript
    for (const field of ['name', 'address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen']) {
```

- [ ] **Step 10: Add the `pronomen` checkbox to `frontend/admin/groups.html`**

In the `#field-checkboxes` container, add one more checkbox alongside the existing 5 field checkboxes (before or after `medicalNotes`, doesn't matter — keep `group` last since it's conceptually different from the PII fields):

```html
          <label><input type="checkbox" value="pronomen"> Pronomen</label>
```

- [ ] **Step 11: Add `pronomen` to `frontend/admin/members.html`'s field label map**

Find `ACCOUNT_FIELD_LABELS` and add:
```javascript
  pronomen: 'Pronomen',
```

- [ ] **Step 12: Write the failing test for the account round-trip**

In `tests/integration/accounts.test.js`, find the `'PATCH /account encrypts and returns sensitive fields...'` test and add a `pronomen` assertion to it — extend the PATCH body and the following assertions:

```javascript
  const patchRes = await fetch(`http://localhost:${port}/account`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ address: 'Musterstraße 1, 12345 Musterstadt', phone: '+49 123 456789', pronomen: 'sie/ihr' }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.address, 'Musterstraße 1, 12345 Musterstadt');
  assert.equal(patched.phone, '+49 123 456789');
  assert.equal(patched.pronomen, 'sie/ihr');
  assert.equal(patched.name, 'Account Test');

  const { rows } = await query('SELECT address_enc, pronomen_enc FROM users WHERE id = $1', [userId]);
  assert.notEqual(rows[0].address_enc.toString('utf8'), 'Musterstraße 1, 12345 Musterstadt');
  assert.notEqual(rows[0].pronomen_enc.toString('utf8'), 'sie/ihr');
```

(Read the actual current test file first — the exact surrounding code may differ slightly from this snippet; adapt the edit to what's really there, keeping the existing assertions intact and adding the `pronomen` ones alongside.)

- [ ] **Step 13: Run the test**

Run: `node --test tests/integration/accounts.test.js`
Expected: PASS.

- [ ] **Step 14: Update `tests/integration/schema-users.test.js`'s group-defaults assertion if one exists, or add a new test confirming the migration's data-update landed**

Add a new test to this file confirming the `009_pronomen_field.sql` data migration actually granted the permission on existing rows:

```javascript
test('admin and orga groups have pronomen in their account_fields after migration', async () => {
  const { rows } = await query("SELECT key, account_fields FROM groups WHERE key IN ('admin', 'orga')");
  for (const row of rows) {
    assert.ok(row.account_fields.includes('pronomen'), `${row.key} should include pronomen`);
  }
});
```

- [ ] **Step 15: Run that test**

Run: `node --test tests/integration/schema-users.test.js`
Expected: PASS (all tests in the file, including the new one and the one added in Task 2 Step 9/10).

- [ ] **Step 16: Verify visually**

Using Claude Browser tools: log in as `admin@pakyrion.local`/`0000`, go to `/account.html`, confirm the Pronomen field appears and round-trips (set a value, save, reload, confirm it persisted). Go to `/admin/groups.html`, confirm the Pronomen checkbox appears in both the create form and when editing a non-protected group (e.g. `orga` — confirm its row already shows `pronomen` checked, proving the data migration applied). Go to `/admin/members.html`, invite a test member with a `pronomen` value pre-filled, confirm it's accepted; clean up the test invitation afterward via `docker compose exec db psql -U app -d pakyrion -c "DELETE FROM invitations WHERE email = '<the test address>';"`.

- [ ] **Step 17: Commit**

```bash
git add db/migrations/009_pronomen_field.sql backend/accountFields.js backend/groups/routes.js backend/members/routes.js backend/accounts/repository.js backend/invitations/repository.js backend/members/repository.js frontend/account.html frontend/admin/groups.html frontend/admin/members.html tests/integration/accounts.test.js tests/integration/schema-users.test.js
git commit -m "feat: add Pronomen account field, consolidate account-field vocabulary into one shared constant"
```

---

### Task 4: NSC section on account.html + member-detail-view gaps + full test suite

**Files:**
- Modify: `backend/accounts/routes.js` (`PATCH /account` extended to accept `nscData`)
- Modify: `backend/accounts/repository.js` (`updateAccount`/`getAccount` extended for `nsc_data`)
- Modify: `frontend/account.html` (NSC section, shown only for `nsc`-group users)
- Modify: `frontend/admin/members.html` (close the deferred gap from the previous plan's final review: read-only display of non-permitted fields, character list, group-reassignment UI)
- Modify: `tests/integration/accounts.test.js`
- Modify: `tests/integration/members.test.js`

**Interfaces:**
- Consumes: Task 1's `collectFieldValues`/`renderField`, Task 2's `GET /nsc-schema`, Task 3's `ACCOUNT_FIELD_KEYS`.

- [ ] **Step 1: Extend `backend/accounts/repository.js` for `nsc_data`**

Add `nsc_data` to `SELECT_COLUMNS`, `decryptAccount`'s return (as `nscData: row.nsc_data`, NOT encrypted — this is not a sensitive PII field like the others, it's performance/scheduling preference data, matching the base spec's original design which never called for encrypting it), and `updateAccount`'s SET clause:

In `SELECT_COLUMNS`, add `users.nsc_data` to the column list.

In `decryptAccount`, add:
```javascript
    nscData: row.nsc_data,
```

In `updateAccount`, add a new parameter and SET clause entry:
```javascript
       nsc_data = COALESCE($9, nsc_data)
```
with the corresponding param:
```javascript
      fields.nscData !== undefined ? JSON.stringify(fields.nscData) : null,
```
(This is the 9th positional param — renumber if Task 3's Step 5 already added an 8th for `pronomen`; the final param list should be `userId, name, address, birthdate, phone, emergencyContact, medicalNotes, pronomen, nscData` in that order, matching `$1` through `$9`.)

- [ ] **Step 2: Validate `nscData` in `backend/accounts/routes.js`**

`PATCH /account` currently passes the whole request body straight to `updateAccount` with no validation. Add a validation step for `nscData` specifically (the other fields are free-text and already have no format validation today — this plan doesn't change that; only `nscData` needs schema validation since it's structured data, same reasoning as character data):

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getAccount, updateAccount } from './repository.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { query } from '../db.js';

router.get('/account', requireAuth(async ({ user }) => {
  const account = await getAccount(user.id);
  return { status: 200, body: account };
}));

router.patch('/account', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  if (body.nscData !== undefined) {
    const { rows } = await query('SELECT schema FROM nsc_profile_schema LIMIT 1');
    const schema = rows[0]?.schema ?? [];
    const errors = validateCharacterData(schema, body.nscData);
    if (errors.length > 0) {
      return { status: 400, body: { error: 'invalid nscData', details: errors } };
    }
  }

  const account = await updateAccount(user.id, body);
  if (!account) return { status: 404, body: { error: 'account not found' } };
  return { status: 200, body: account };
}));
```

- [ ] **Step 3: Write the failing test for `nscData`**

Add to `tests/integration/accounts.test.js`:

```javascript
test('PATCH /account validates nscData against the current nsc_profile_schema', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await registerLoginAndGetCookie(port);
    const res = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ nscData: { notARealField: 'x' } }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /account accepts and round-trips valid nscData', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await registerLoginAndGetCookie(port);
    const res = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ nscData: { fuerOrgaanfragenOffen: true, darstellungsstaerken: 'Wachen, Händler' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.nscData.fuerOrgaanfragenOffen, true);
    assert.equal(body.nscData.darstellungsstaerken, 'Wachen, Händler');
  } finally {
    server.close();
  }
});
```

(Read `tests/integration/accounts.test.js`'s actual current content first — this uses the file's existing `registerLoginAndGetCookie(port)` helper and `createServer().listen(0)` pattern; match whatever the file's real structure is rather than assuming.)

- [ ] **Step 4: Run the test**

Run: `node --test tests/integration/accounts.test.js`
Expected: all tests PASS (existing + new).

- [ ] **Step 5: Add the NSC section to `frontend/account.html`**

Add a new section after the existing form (or integrate into the same form — simplest is a second `<form>` so the two save actions don't interfere, matching how `characters.html` keeps its registration table and character form as separate concerns):

```html
    <div id="nsc-section" style="display:none;">
      <h2>NSC-Profil</h2>
      <form id="nsc-form">
        <div id="nsc-fields"></div>
        <button type="submit">NSC-Profil speichern</button>
      </form>
    </div>
```

In the script, add the import and rendering/submission logic:

```javascript
import { renderField, collectFieldValues } from '/js/formFields.js';
```

Inside `loadAccount()`, after the existing field-population loop, add:
```javascript
    if (account.group.key === 'nsc') {
      const schemaRes = await api.get('/nsc-schema');
      document.getElementById('nsc-fields').innerHTML = schemaRes
        .map((field) => renderField(field, account.nscData?.[field.key]))
        .join('');
      document.getElementById('nsc-section').style.display = '';
      document.getElementById('nsc-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        message.textContent = '';
        message.className = '';
        const nscData = collectFieldValues(document.getElementById('nsc-form'), schemaRes);
        try {
          await api.patch('/account', { nscData });
          message.textContent = 'Gespeichert.';
          message.className = 'success';
        } catch (err) {
          message.textContent = err.status === 400 && err.body?.details ? err.body.details.join(', ') : err.message;
          message.className = 'error';
        }
      });
    }
```

Read the actual current `account.html` (as landed by Task 3) before editing — the exact surrounding structure may differ slightly; place this logic sensibly relative to the existing `loadAccount` function and don't duplicate the `try/catch`/401-redirect wrapper it already has.

- [ ] **Step 6: Close the deferred member-detail-view gap in `frontend/admin/members.html`**

The previous plan's final review found three things the base spec asked for that never got built: non-permitted fields shown as read-only text (not omitted), the member's character list, and a way for a permitted viewer to reassign a member's group. Fix all three in `openDetail`/`buildFieldInputs` (or wherever the current file structures this — read it first):

1. **Read-only fields**: for each of the account field keys NOT in `myAccountFields`, render the label + the value as plain text instead of omitting it. The member detail response (`GET /members/:id`) already includes every field's value regardless of the viewer's permissions (only `PATCH` enforces the allowlist) — read `backend/members/repository.js`'s `getMember` to confirm this is still true, then render accordingly:
   ```javascript
   const ALL_FIELD_KEYS = ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen'];
   function buildFieldInputs(container, values = {}) {
     container.innerHTML = ALL_FIELD_KEYS.map((key) => {
       const label = ACCOUNT_FIELD_LABELS[key] ?? key;
       if (myAccountFields.includes(key)) {
         return `<label for="field-${key}">${escapeHtml(label)}</label><input id="field-${key}" data-field="${key}" type="text" value="${escapeHtml(values[key] ?? '')}">`;
       }
       return `<label>${escapeHtml(label)}</label><p>${escapeHtml(values[key] ?? '–')}</p>`;
     }).join('');
   }
   ```
   (This changes `buildFieldInputs`'s field list from the current `myAccountFields.filter(...)`-driven approach to iterating ALL known fields and branching per-field on whether it's editable — needed because the invite form still only wants to show/submit permitted fields, so keep the invite form's OWN call to a version that filters to `myAccountFields` only; only the member-DETAIL view needs the read-only branch. If the current file structure makes this awkward to share cleanly between invite and detail, it's fine to have two small, slightly different rendering functions rather than forcing one function to serve both — don't over-abstract this.)

2. **Character list**: in `openDetail`, after fetching the member, render `member.characters` (already returned by `GET /members/:id`, just never displayed) as a simple read-only list:
   ```javascript
   const charList = (member.characters ?? []).map((c) => `<li>${escapeHtml(c.name)} (${escapeHtml(c.eventName)})</li>`).join('');
   document.getElementById('detail-characters').innerHTML = member.characters?.length
     ? `<h3>Charaktere</h3><ul>${charList}</ul>`
     : '';
   ```
   Add a `<div id="detail-characters"></div>` to the detail card's markup (between the fields and the Speichern/Schließen buttons).

3. **Group reassignment**: when `myAccountFields.includes('group')`, add a group `<select>` to the detail-edit form (populated the same way the invite form's group selector already is — reuse `loadGroupOptions()`'s pattern, gated the same way). On save, include the selected group's key in the PATCH payload as `group`.

- [ ] **Step 7: Verify visually**

Using Claude Browser tools: log in as `admin@pakyrion.local`/`0000`. On `/account.html`, confirm no NSC section appears (admin isn't in the `nsc` group). Create a throwaway `nsc`-group user (via the invite flow or direct SQL + password set), log in as them, confirm the NSC section appears on `/account.html` with all the default fields rendered correctly (checkboxes for the 2 booleans, selects for the 10 scales, a checkbox group for `rollenAusruestung`, textareas for the 2 free-text fields), fill in a few, save, reload, confirm they persisted. On `/admin/members.html`, open a member's detail view as admin and confirm non-permitted-for-someone-else-but-permitted-for-admin fields still show as inputs (admin has all fields, so this specific negative case needs a second browser session or a lower-privilege test account — use your judgment on how deep to verify this given time, but at minimum confirm the character list renders for a member who has characters, and confirm the group reassignment select appears and works). Clean up all test accounts/data created during this verification afterward.

- [ ] **Step 8: Run the FULL test suite**

Run: `npm test`
Expected: every test in the project passes (178 before this plan + this plan's new tests — expect roughly 195-200 total, all green, 0 failures). This is the mandatory full-suite check per this plan's Global Constraints — do not skip it or substitute a scoped subset. If anything fails, fix it before considering this plan done.

- [ ] **Step 9: Final commit if Step 8 required fixes**

If Step 8 was already green with no changes needed, skip this step. Otherwise:

```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

- [ ] **Step 10: Commit**

```bash
git add backend/accounts/routes.js backend/accounts/repository.js frontend/account.html frontend/admin/members.html tests/integration/accounts.test.js tests/integration/members.test.js
git commit -m "feat: add NSC profile section to account.html, close member-detail-view gaps"
```

## Self-Review Notes (for the plan author / controller, not a task)

- Spec coverage: covers every section of `2026-08-27-sc-nsc-profilfelder-design.md` (new field types, SC schema extension, NSC profile schema + endpoints, Pronomen field end to end including the data-migration gotcha for existing DB rows) PLUS the explicitly-carried-over member-detail-view gap from the previous plan's final review, folded into Task 4 as that review recommended.
- Type/shape consistency: `collectFieldValues(form, schema)` (Task 1) is consumed identically by `characters.html` (Task 1's own fix) and `account.html`'s NSC section (Task 4) — same two-argument shape, same return shape (plain object keyed by field key). `ACCOUNT_FIELD_KEYS` (Task 3) replaces two independently-drifting inline copies with one import, consumed identically by `groups/routes.js` and `members/routes.js`.
- The `pronomen`-in-existing-groups migration (Task 3) is the one place this plan does real DATA migration (not just schema DDL) — flagged explicitly with reasoning in Task 3 Step 1, and verified by a dedicated test in Step 14, precisely because a previous plan's spec update (adding a value to a JS defaults array) alone would have silently done nothing to an already-seeded database.
