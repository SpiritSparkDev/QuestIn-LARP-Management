# Charakter-Feld-Sichtbarkeit + Link-Feldtyp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `link` field type to character schemas, let admins/orga mark any schema field as `public` when building an event's character form, and let any authenticated user browse other players' characters' public fields for an event — something that currently has no UI at all.

**Architecture:** `public: boolean` is stored directly on each schema field object inside the existing `character_form_schema` JSONB column — no new table, no migration. Visibility is enforced by one new backend helper (`filterCharacterFields`) reused by a single new read endpoint; "elevated" access reuses the existing `canOverrideCheckinStatus` group permission (already exactly Admin/Orga/SL by default) rather than adding a new one. The browse page is a new, separate frontend page (not woven into `characters.html`'s existing own-character UI) since it's read-only and shows OTHER users' data — a fundamentally different view.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, vanilla JS frontend, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` (Teil 4)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step.
- "Private" (the default when a field has no `public: true`) means: the character's owner, plus any group with `canOverrideCheckinStatus: true` (Admin/Orga/SL by default — the existing permission, not a new one). "Public" additionally includes every other authenticated user.
- `public` is a per-FIELD property inside `character_form_schema` (set by admin/orga when building an event's schema), never a per-character or per-value property.
- Deliberate simplification from the spec's literal wording: the new browse endpoint returns EVERY character for the event (including the caller's own), each filtered through the same visibility rule — since the owner always sees their own data in full via that same filter, there is no need to special-case excluding "your own" characters from the list. This is simpler than maintaining two different endpoints/branches for "your own" vs "everyone else" and produces the identical visible result for the caller.

---

### Task 1: Link-Feldtyp

**Files:**
- Modify: `backend/events/schemaValidation.js`
- Modify: `frontend/js/formFields.js`

**Interfaces:**
- Extends `validateCharacterData(schema, data)`'s existing per-type validation with a `link` branch. Extends `renderField(field, value)`'s existing per-type branches with a `link` branch (renders as `<input type="url">`, matching the label-below-input convention every other branch in this function already uses since an earlier plan).

- [ ] **Step 1: Add `link` validation to `backend/events/schemaValidation.js`**

Read the current file first (73 lines) to confirm it matches what's below. In `validateCharacterData`, find the existing type-check chain (`text`/`textarea`, `select`, `boolean`, `multiselect`, `number` — one `if (!isEmpty && field.type === '...')` block per type) and add a new one, anywhere in that chain (e.g. right after the `number` block):

```javascript
    if (!isEmpty && field.type === 'link' && typeof value !== 'string') {
      errors.push(`${field.key} must be a string`);
    }
    if (!isEmpty && field.type === 'link' && typeof value === 'string' && !/^https?:\/\//.test(value)) {
      errors.push(`${field.key} must start with http:// or https://`);
    }
```

(No change needed elsewhere in this file — `validateSchemaShape` already accepts any field object shape beyond `key`/reserved-key/duplicate-key checks, so a `link`-typed field or a `public: true` property on any field flows through it untouched, and `MAX_VALUE_LENGTH`/`MAX_TOTAL_LENGTH` already apply generically to every string-typed value including `link`.)

- [ ] **Step 2: Add `link` rendering to `frontend/js/formFields.js`**

Read the current file first (as modified by an earlier plan — `renderField`'s `number`/`textarea`/`select`/default-`text` branches all render input-before-label; `boolean`/`multiselect` render label-wrapping-input; confirm this shape before editing). Add a new branch, placed anywhere before the final default-`text` fallback (e.g. right after the `number` branch):

```javascript
  if (field.type === 'link') {
    return `<input id="${id}" name="${key}" type="url" value="${val}" ${required}><label for="${id}">${label}</label>`;
  }
```

- [ ] **Step 3: Add unit test coverage**

Read `tests/unit/formFields.test.js`'s current content and `tests/unit/schemaValidation.test.js` if it exists (check `tests/unit/` for the actual filename — it may be named differently). Add one test per file matching the existing style:

For `formFields.test.js`, mirroring the existing `renderField renders a text input...` test:
```javascript
test('renderField renders a URL input for type "link"', () => {
  const html = renderField({ key: 'characterSheet', label: 'Charakterbogen', type: 'link' }, 'https://example.com/sheet');
  assert.ok(html.includes('type="url"'));
  assert.ok(html.includes('name="characterSheet"'));
  assert.ok(html.includes('value="https://example.com/sheet"'));
});
```

For the schema-validation test file, mirroring its existing per-type validation tests:
```javascript
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
```
(Match whatever import/assertion style the actual current file uses — read it first.)

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/formFields.test.js tests/unit/schemaValidation.test.js` (adjust the second filename to whatever you found it actually is in Step 3)
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/events/schemaValidation.js frontend/js/formFields.js tests/unit/formFields.test.js tests/unit/schemaValidation.test.js
git commit -m "feat: add link field type for character schemas"
```

(Adjust the schema-validation test filename in the `git add` to match Step 3's actual finding.)

---

### Task 2: Sichtbarkeits-Filter + Durchsuchen-Endpoint

**Files:**
- Create: `backend/characters/visibility.js`
- Modify: `backend/characters/repository.js`
- Modify: `backend/characters/routes.js`
- Create: `tests/integration/charactersVisibility.test.js`

**Interfaces:**
- Produces: `filterCharacterFields(character, schema, viewer)` from `backend/characters/visibility.js` — `character` is a row shape with `user_id`/`data` (as returned by the repository), `schema` is an event's `character_form_schema` array, `viewer` is `ctx.user` (has `.id` and `.group.canOverrideCheckinStatus`). Returns the full `data` object unchanged if the viewer owns the character or their group has `canOverrideCheckinStatus: true`; otherwise returns a new object containing only the keys whose schema field has `public: true`.
- Produces: `listCharactersForEvent(eventId)` from `backend/characters/repository.js` — all `class: 'sc'` characters for an event, ordered by name.
- Produces: `GET /events/:eventId/characters/public` — any authenticated user; 404 if the event doesn't exist; otherwise returns an array of `{id, name, userId, data}` where `data` has already been filtered per-viewer via `filterCharacterFields`.

- [ ] **Step 1: Create the visibility helper**

Create `backend/characters/visibility.js`:

```javascript
export function filterCharacterFields(character, schema, viewer) {
  const isOwner = character.user_id === viewer.id;
  const isElevated = viewer.group.canOverrideCheckinStatus;
  if (isOwner || isElevated) return character.data;

  const publicKeys = new Set(schema.filter((field) => field.public === true).map((field) => field.key));
  const filtered = {};
  for (const key of Object.keys(character.data)) {
    if (publicKeys.has(key)) filtered[key] = character.data[key];
  }
  return filtered;
}
```

- [ ] **Step 2: Add `listCharactersForEvent` to `backend/characters/repository.js`**

Read the current file first (as modified by earlier plans in this project — confirm `SELECT_COLUMNS`'s exact current value before editing). Add this function anywhere after `listCharactersForUser`:

```javascript
export async function listCharactersForEvent(eventId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM characters WHERE event_id = $1 AND class = 'sc' ORDER BY name`,
    [eventId]
  );
  return rows;
}
```

- [ ] **Step 3: Add the route**

Read `backend/characters/routes.js`'s current content first. Add the import:
```javascript
import { createCharacter, getCharacter, listCharactersForUser, updateCharacter } from './repository.js';
```
becomes:
```javascript
import { createCharacter, getCharacter, listCharactersForUser, listCharactersForEvent, updateCharacter } from './repository.js';
import { filterCharacterFields } from './visibility.js';
```
Add the new route anywhere after the existing `GET /characters` route:
```javascript
router.get('/events/:eventId/characters/public', requireAuth(async ({ params, user }) => {
  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const characters = await listCharactersForEvent(params.eventId);
  const filtered = characters.map((c) => ({
    id: c.id,
    name: c.name,
    userId: c.user_id,
    data: filterCharacterFields(c, event.character_form_schema, user),
  }));
  return { status: 200, body: filtered };
}));
```
(`getEvent` is already imported in this file, per its existing use in the `POST /characters` handler — confirm this before assuming, read the current import line.)

- [ ] **Step 4: Register the route module (verify, likely already done)**

Read `backend/server.js` and confirm `./characters/routes.js` is already statically imported (it must be, since `POST /characters` already works) — no change needed here, this step is just a confirmation, not an edit.

- [ ] **Step 5: Write integration tests**

Create `tests/integration/charactersVisibility.test.js`. Read `tests/integration/characters.test.js`'s current top-of-file setup first (env vars, `runMigrations()`, `seedGroups()`, `withTestServer` import, `makeUserAndSession` helper, `makeEvent` helper if one exists there) and mirror that exact pattern rather than guessing — this project has ~15 near-identical integration test file headers, copy the established shape precisely.

Cover, at minimum:
- A character with a schema field NOT marked `public` — the OWNER sees it via `GET /events/:eventId/characters/public`, a DIFFERENT non-elevated user does NOT see that field's key at all in their view of the same character.
- A character with a schema field marked `public: true` — a different non-elevated user DOES see that field.
- A user in a `canOverrideCheckinStatus: true` group (e.g. `admin`) sees ALL fields of ALL characters for the event, public or not.
- `GET /events/:eventId/characters/public` for an unknown event id returns 404.
- The response includes characters from multiple different users for the same event, each independently filtered per the viewer.

Write the exact test bodies yourself based on the established patterns in `characters.test.js` (make an event with a schema containing at least one `public: true` and one non-public field, create characters as different users, fetch as different viewers, assert on `data`'s exact key set via `assert.deepEqual(Object.keys(body.find(c => c.id === targetId).data).sort(), [...].sort())` or similar).

- [ ] **Step 6: Run the tests**

Run: `node --test tests/integration/charactersVisibility.test.js --test-concurrency=1`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/characters/visibility.js backend/characters/repository.js backend/characters/routes.js tests/integration/charactersVisibility.test.js
git commit -m "feat: add character field visibility filtering and a public-characters browse endpoint"
```

---

### Task 3: Schema-Builder — Link-Typ + Öffentlich-Checkbox

**Files:**
- Modify: `frontend/admin/events.html`

**Interfaces:**
- Consumes: nothing new from earlier tasks (this task only touches the schema-authoring UI, which writes to the same `character_form_schema` JSONB the backend already accepts unchanged).

- [ ] **Step 1: Add "Link" to the type dropdown**

Read the current file first (204 lines). In `addSchemaRow`, find:
```javascript
      <option value="multiselect" ${field.type === 'multiselect' ? 'selected' : ''}>Mehrfachauswahl</option>
```
and add immediately after it:
```javascript
      <option value="link" ${field.type === 'link' ? 'selected' : ''}>Link</option>
```

- [ ] **Step 2: Add the "Öffentlich" checkbox per row**

In `addSchemaRow`, find:
```javascript
    <label><input type="checkbox" class="schema-required" ${field.required ? 'checked' : ''}> Pflichtfeld</label>
    <button type="button" class="remove-row">Entfernen</button>
```
change to:
```javascript
    <label><input type="checkbox" class="schema-required" ${field.required ? 'checked' : ''}> Pflichtfeld</label>
    <label><input type="checkbox" class="schema-public" ${field.public ? 'checked' : ''}> Öffentlich sichtbar</label>
    <button type="button" class="remove-row">Entfernen</button>
```
Also update `addSchemaRow`'s default-parameter object (its first line) so a brand-new row has an explicit, correct default:
```javascript
function addSchemaRow(field = { key: '', label: '', type: 'text', required: false, options: [] }) {
```
becomes:
```javascript
function addSchemaRow(field = { key: '', label: '', type: 'text', required: false, public: false, options: [] }) {
```

- [ ] **Step 3: Include `public` when collecting the schema**

In `collectSchema()`, find:
```javascript
    const field = {
      key: row.querySelector('.schema-key').value.trim(),
      label: row.querySelector('.schema-label').value.trim(),
      type,
      required: row.querySelector('.schema-required').checked,
    };
```
change to:
```javascript
    const field = {
      key: row.querySelector('.schema-key').value.trim(),
      label: row.querySelector('.schema-label').value.trim(),
      type,
      required: row.querySelector('.schema-required').checked,
      public: row.querySelector('.schema-public').checked,
    };
```

- [ ] **Step 4: Manual verification**

Start the dev server, use the Browser tool: log in as admin, go to `/admin/events.html`, edit an existing event (or create one), add a field, select "Link" as its type, check "Öffentlich sichtbar", save. Reload the page, re-open that event for editing, confirm the Link type and the Öffentlich checkbox both show their saved state correctly. Screenshot as evidence.

- [ ] **Step 5: Commit**

```bash
git add frontend/admin/events.html
git commit -m "feat: add link field type and public-visibility checkbox to the event schema builder"
```

---

### Task 4: Charaktere-durchsuchen-Seite

**Files:**
- Create: `frontend/characters-browse.html`
- Modify: `frontend/characters.html`

**Interfaces:**
- Consumes: `GET /events/:eventId/characters/public` from Task 2.

- [ ] **Step 1: Add a link from `characters.html` to the new page**

Read the current file first (as modified by earlier plans — confirm the exact current markup around `<h2>Meine Charaktere</h2>` at the top of the character-list section, line ~28). Add one line right after that heading:
```html
    <h2>Meine Charaktere</h2>
    <p><a href="/characters-browse.html">Charaktere anderer Spieler durchsuchen</a></p>
    <div id="character-list" class="char-grid"></div>
```

- [ ] **Step 2: Create `frontend/characters-browse.html`**

Follow the structural pattern already established by `frontend/characters.html` (same theme, same nav-links/logout boilerplate, same `char-grid`/`char-card` CSS classes already defined in `chronicle-crest.css` and used by the existing character list):

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Charaktere durchsuchen – Pakyrion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/chronicle-crest.css">
</head>
<body>
<div class="shell">
  <div class="brand"><div class="brand-seal">P</div><div class="brand-name">Pakyrion</div></div>
  <p class="brand-sub">QuestIn LARP Management</p>
  <div class="folio folio--wide">
    <nav class="app-nav" id="nav-links"></nav>
    <a href="#" id="logout-link">Logout</a>
    <h1>Charaktere durchsuchen</h1>
    <p><a href="/characters.html">← Zurück zu meinen Charakteren</a></p>
    <label for="event-select">Event</label>
    <select id="event-select"></select>
    <div id="character-list" class="char-grid"></div>
    <p id="message"></p>
  </div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { escapeHtml } from '/js/formFields.js';
import { renderNavLinks } from '/js/nav.js';

const eventSelect = document.getElementById('event-select');
const listBody = document.getElementById('character-list');
const message = document.getElementById('message');

let events = [];

function tagValueForField(field, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
  if (Array.isArray(rawValue)) return rawValue.length > 0 ? rawValue.join(', ') : undefined;
  if (typeof rawValue === 'boolean') return rawValue ? 'Ja' : undefined;
  return rawValue;
}

function renderTag(field, value) {
  if (field.type === 'link') {
    return `<span class="tag">${escapeHtml(field.label)}: <a href="${escapeHtml(value)}" target="_blank" rel="noopener">${escapeHtml(value)}</a></span>`;
  }
  return `<span class="tag">${escapeHtml(field.label)}: ${escapeHtml(value)}</span>`;
}

function tagsForCharacter(character, schema) {
  return schema
    .map((field) => ({ field, value: tagValueForField(field, character.data[field.key]) }))
    .filter(({ value }) => value !== undefined)
    .map(({ field, value }) => renderTag(field, value))
    .join('');
}

async function loadCharacters() {
  message.textContent = '';
  const eventId = eventSelect.value;
  if (!eventId) { listBody.innerHTML = ''; return; }
  const event = events.find((e) => e.id === eventId);
  const schema = event ? event.character_form_schema : [];
  try {
    const characters = await api.get(`/events/${eventId}/characters/public`);
    if (characters.length === 0) {
      listBody.innerHTML = '<p>Keine Charaktere für dieses Event.</p>';
      return;
    }
    listBody.innerHTML = characters.map((c) => `<div class="char-card">
      <h3>${escapeHtml(c.name)}</h3>
      <div class="char-tags">${tagsForCharacter(c, schema)}</div>
    </div>`).join('');
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
}

eventSelect.addEventListener('change', loadCharacters);

document.getElementById('logout-link').addEventListener('click', async (evt) => {
  evt.preventDefault();
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});

try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  events = await api.get('/events');
  eventSelect.innerHTML = events.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.event_date)})</option>`).join('');
  await loadCharacters();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
</script>
</body>
</html>
```

(Every character's fields not marked `public` are simply absent from `data` for a non-elevated viewer — Task 2's `filterCharacterFields` already strips them server-side, so this page never needs its own permission logic beyond rendering whatever keys the response actually contains.)

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: as a non-admin/non-elevated test user (e.g. `sc@pakyrion.local` if seeded, or any `sc`-group account), go to `/characters.html`, click "Charaktere anderer Spieler durchsuchen", select an event, confirm other players' characters show ONLY their public fields (create a test character as a different user first, with one public and one private field, if none exists yet — use the Browser tool across two separate login sessions/tabs, or verify via the API directly with `read_network_requests` if a second UI session is impractical). Then log in as `admin@pakyrion.local` and confirm the same character shows ALL its fields on this page. Screenshot both views as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/characters-browse.html frontend/characters.html
git commit -m "feat: add a page to browse other players' public character fields"
```

---

### Task 5: Full test suite

**Files:** None (verification-only task).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test in the project passes. Mandatory final gate — do not skip or substitute a scoped subset.

- [ ] **Step 2: Commit if Step 1 required fixes**

If Step 1 was already green, skip this step. Otherwise:
```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

## Self-Review Notes

- Spec coverage: covers Teil 4 of `2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` in full (link field type, per-field public/private, browse page, new endpoint).
- Deliberate simplification from the spec's literal wording, documented in Global Constraints: the browse endpoint returns every character for the event (including the caller's own, fully visible via the same filter's owner-check) rather than maintaining a separate "exclude my own" branch — simpler, same visible result to the caller.
- Type/interface consistency: `filterCharacterFields(character, schema, viewer)`'s signature and the `{isOwner, isElevated}` visibility rule are used identically in the one route that calls it (Task 2) and match the plan's Global Constraints wording exactly (owner + `canOverrideCheckinStatus` groups = private access; everyone else = public-only).
- No schema/migration change needed for `public` — it's stored as an ordinary property inside the already-JSONB `character_form_schema`, and `validateSchemaShape` already accepts arbitrary extra field properties (verified against its current implementation before writing this plan, not assumed).
