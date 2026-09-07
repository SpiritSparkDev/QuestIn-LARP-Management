# Check-In Ad-hoc-Bearbeitung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check-In-Personal kann direkt aus `admin/checkin.html` heraus, ohne Seitenwechsel, Konto-Felder (OT, z. B. `photoOptOut`) und Charakter-Felder (IT) eines Teilnehmers spontan bearbeiten (Beispiel: "kein Foto mehr" am Einlass).

**Architecture:** Ein neuer "Bearbeiten"-Button pro Teilnehmerzeile öffnet einen `<dialog>` mit zwei Abschnitten: OT-Felder (wiederverwendet exakt die Checkbox-/Text-Widgets, die gerade in `admin/members.html` gebaut wurden — dafür wird die dort schon fast duplizierte Logik in `formFields.js` extrahiert) und, pro Charakter des Teilnehmers, dessen Schema-Felder (wiederverwendet `renderField`/`collectFieldValues`, exakt wie auf `characters.html`). OT-Felder sind über die bestehende `account_fields`-Permission gegated (nichts Neues nötig — die Teilnehmerliste liefert `otFields` bereits exakt permission-gefiltert). Charakter-Felder brauchen eine echte Backend-Änderung: `PUT /characters/:id` erlaubt heute AUSSCHLIESSLICH dem Besitzer selbst zu editieren — das wird um `canOverrideCheckinStatus`-Personal erweitert (dieselbe Berechtigung, die `GET /characters/:id` schon für "volle Fremd-Ansicht" nutzt).

**Tech Stack:** Node.js (kein Framework), PostgreSQL, `node:test`, vanilla JS/HTML Frontend.

**Spec:** Kein separates Spec-Dokument — Design wurde direkt im Chat abgestimmt (bounded-Pfad des brainstorming-Skills). Diese Datei ist die alleinige Quelle der Wahrheit für die Umsetzung.

## Global Constraints

- IT-Feld-Bearbeitung fremder Charaktere ist AUSSCHLIESSLICH über `user.group.canOverrideCheckinStatus` gegated — nicht über `canEditCharacters` (das bleibt unverändert "darf eigene Charaktere erstellen/bearbeiten").
- OT-Feld-Bearbeitung ist über die bestehende `account_fields`-Permission gegated — keine neue Permission.
- Die Dialog-Speicherung MUSS für jeden bearbeiteten Charakter das VOLLSTÄNDIGE `data`-Objekt senden (nicht nur geänderte Felder) — `PUT /characters/:id` ersetzt `data` komplett (`COALESCE`), ein Teil-Objekt würde stillschweigend alle nicht enthaltenen Felder löschen. Der Dialog wird deshalb nur bei `canOverrideCheckinStatus === true` angezeigt (die Teilnehmerliste liefert dann bereits die vollständigen, ungefilterten `data`-Objekte — siehe `backend/characters/visibility.js`).
- Volle Testsuite (`npm test`) muss am Ende dieses Plans grün sein.

---

### Task 1: Backend — `PUT /characters/:id` für Check-In-Personal öffnen

**Files:**
- Modify: `backend/characters/routes.js`
- Test: `tests/integration/characters.test.js`

**Interfaces:**
- Produces: `PUT /characters/:id` akzeptiert jetzt zusätzlich zum Besitzer auch Anfragen von `user.group.canOverrideCheckinStatus === true` — für jeden fremden Charakter, unabhängig vom Event. Antwortverhalten für den Besitzer-Fall bleibt exakt wie vorher.

- [ ] **Step 1: Read the existing route and its current test coverage first**

Run: `grep -n "PUT /characters" -A 20 backend/characters/routes.js` and `grep -n "PUT /characters\|characters/\${.*}\`, {" -B2 -A 20 tests/integration/characters.test.js` to see the exact current 403-for-non-owner test, so Step 5 below extends it correctly rather than duplicating a similarly-named test.

- [ ] **Step 2: Write the failing test**

Read `tests/integration/characters.test.js` first to find its existing helper for creating a user+session in a given group (likely named similarly to `makeUserAndSession`) and its existing helper/pattern for creating a character directly via the repository or via `POST /characters` — reuse whatever's already there rather than reinventing it. Add:

```javascript
test('PUT /characters/:id allows a canOverrideCheckinStatus group to edit another user\'s character', async () => {
  await withTestServer(async (port) => {
    const { userId: ownerId, cookie: ownerCookie } = await makeUserAndSession('sc');
    const { cookie: slCookie } = await makeUserAndSession('sl'); // sl defaults to canOverrideCheckinStatus: true

    const eventRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: (await makeUserAndSession('admin')).cookie },
      body: JSON.stringify({ name: 'Ad-hoc Edit Event', eventDate: '2026-12-01', characterFormSchema: [{ key: 'notiz', label: 'Notiz', type: 'text' }] }),
    });
    const event = await eventRes.json();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ characterClass: 'sc', eventId: event.id, name: 'Fremdcharakter', data: { notiz: 'alt' } }),
    });
    const character = await createRes.json();

    const updateRes = await fetch(`http://localhost:${port}/characters/${character.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: slCookie },
      body: JSON.stringify({ data: { notiz: 'neu' } }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.data.notiz, 'neu');
    assert.equal(updated.user_id, ownerId);
  });
});

test('PUT /characters/:id still rejects a group WITHOUT canOverrideCheckinStatus editing another user\'s character', async () => {
  await withTestServer(async (port) => {
    const { cookie: ownerCookie } = await makeUserAndSession('sc');
    const { cookie: hilfsSlCookie } = await makeUserAndSession('hilfs_sl'); // hilfs_sl defaults to canOverrideCheckinStatus: false

    const eventRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: (await makeUserAndSession('admin')).cookie },
      body: JSON.stringify({ name: 'Ad-hoc Edit Event 2', eventDate: '2026-12-01', characterFormSchema: [{ key: 'notiz', label: 'Notiz', type: 'text' }] }),
    });
    const event = await eventRes.json();

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ characterClass: 'sc', eventId: event.id, name: 'Fremdcharakter 2', data: { notiz: 'alt' } }),
    });
    const character = await createRes.json();

    const updateRes = await fetch(`http://localhost:${port}/characters/${character.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: hilfsSlCookie },
      body: JSON.stringify({ data: { notiz: 'neu' } }),
    });
    assert.equal(updateRes.status, 403);
  });
});
```

Adjust the exact request bodies above (`characterFormSchema` vs `character_form_schema`, `eventDate` vs `event_date`, etc.) to match whatever field-naming the existing `POST /events` and `POST /characters` tests in this same file actually use — copy their exact shape rather than guessing from this plan.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/integration/characters.test.js`
Expected: the first new test FAILs with `403` instead of `200` (current code always 403s a non-owner). The second new test should already PASS (it's asserting today's existing behavior) — if it doesn't, something about the test setup is wrong; fix the setup before continuing, don't touch production code for it.

- [ ] **Step 4: Modify `backend/characters/routes.js`**

Find the `router.put('/characters/:id', ...)` handler and change its authorization + the `updateCharacter` call:
```javascript
router.put('/characters/:id', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const isOwner = character.user_id === user.id;
  const isElevated = user.group.canOverrideCheckinStatus;
  if (!isOwner && !isElevated) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const updated = await updateCharacter(params.id, character.user_id, body);
    return { status: 200, body: updated };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));
```
The one substantive change from the current code: `updateCharacter(params.id, character.user_id, body)` — passing the CHARACTER'S OWNER id (already fetched above), not `user.id` (the caller). `updateCharacter`'s own `WHERE id = $1 AND user_id = $2` SQL predicate needs the owner's id to match the row regardless of who's calling; today it coincidentally works because owner and caller were always required to be the same person.

- [ ] **Step 5: Run the tests again to verify they pass**

Run: `node --test tests/integration/characters.test.js`
Expected: both new tests PASS, and every pre-existing test in the file still passes (the owner-editing-their-own-character path is unchanged — `character.user_id` when `isOwner` is true is by definition equal to `user.id`, so passing it instead of `user.id` there is a no-op).

- [ ] **Step 6: Commit**

```bash
git add backend/characters/routes.js tests/integration/characters.test.js
git commit -m "feat: allow canOverrideCheckinStatus staff to edit another user's character"
```

---

### Task 2: Frontend — Shared OT-Feld-Widget-Helper in `formFields.js`

**Files:**
- Modify: `frontend/js/formFields.js`
- Modify: `frontend/admin/members.html`
- Test: `tests/unit/formFields.test.js`

**Interfaces:**
- Produces: `OPT_OUT_KEYS` (exported array, moved out of `admin/members.html`), `renderAccountFieldInput(key, label, value, { sealedBadge } = {})` → HTML string (new, in `formFields.js`).
- Consumes (Task 3 will use these too): both of the above.

This task's own purpose is to de-duplicate the OT-field-input-rendering logic that currently lives inline in `admin/members.html`'s `buildFieldInputs`/`buildDetailFieldInputs`, BEFORE Task 3 would otherwise duplicate it a third time into `checkin.html`. `admin/members.html`'s actual rendered output must not change at all — this is a pure refactor, verified by running its existing manual-verification steps again, not new behavior.

- [ ] **Step 1: Add `OPT_OUT_KEYS` and `renderAccountFieldInput` to `formFields.js`**

Add, right after the existing `isOptOutYes` function:
```javascript
// Free text let a caller type anything besides Ja/Nein; these two are
// rendered as checkboxes everywhere they're editable instead.
export const OPT_OUT_KEYS = ['dataSharingOptOut', 'photoOptOut'];

// Renders one OT (account) field as a labeled input: a checkbox for the two
// Ja/Nein opt-out keys, a text input otherwise. `sealedBadge`, if given, is
// raw HTML appended to the label (e.g. the lock-icon "Verschlüsselt" badge).
export function renderAccountFieldInput(key, label, value, { sealedBadge = '' } = {}) {
  const escapedLabel = escapeHtml(label);
  if (OPT_OUT_KEYS.includes(key)) {
    const checked = isOptOutYes(value) ? ' checked' : '';
    return `<label for="field-${key}"><input id="field-${key}" data-field="${key}" type="checkbox"${checked}> ${escapedLabel}${sealedBadge}</label>`;
  }
  return `<label for="field-${key}">${escapedLabel}${sealedBadge}</label><input id="field-${key}" data-field="${key}" type="text" value="${escapeHtml(value ?? '')}">`;
}
```
(`escapeHtml` is defined further down in this same file but is a hoisted `function` declaration, so calling it here before its own definition line is fine — matches how `renderEventOptions` already does the same thing in this file.)

- [ ] **Step 2: Run the existing unit tests for `formFields.js`**

Run: `node --test tests/unit/formFields.test.js`
Expected: PASS (adding new exports doesn't change any existing behavior).

- [ ] **Step 3: Write a unit test for the new helper**

Read `tests/unit/formFields.test.js` first to match its existing style (likely plain `node:test` + `assert` with a minimal DOM-free string-comparison approach, since `renderField` etc. are already tested that way there). Add:
```javascript
test('renderAccountFieldInput renders opt-out keys as checkboxes and others as text', () => {
  const checkboxHtml = renderAccountFieldInput('photoOptOut', 'Keine Fotoveröffentlichung', 'Ja');
  assert.match(checkboxHtml, /type="checkbox"/);
  assert.match(checkboxHtml, / checked/);

  const uncheckedHtml = renderAccountFieldInput('photoOptOut', 'Keine Fotoveröffentlichung', 'Nein');
  assert.doesNotMatch(uncheckedHtml, / checked/);

  const textHtml = renderAccountFieldInput('address', 'Adresse', 'Musterstr. 1');
  assert.match(textHtml, /type="text"/);
  assert.match(textHtml, /value="Musterstr\. 1"/);
});

test('renderAccountFieldInput appends the sealedBadge HTML after the label text when given', () => {
  const html = renderAccountFieldInput('address', 'Adresse', '', { sealedBadge: '<span class="sealed">X</span>' });
  assert.match(html, /Adresse<span class="sealed">X<\/span><\/label>/);
});
```
Add `renderAccountFieldInput` to whatever import line at the top of the test file already imports `renderField`/`escapeHtml`/etc. from `../../frontend/js/formFields.js`.

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/unit/formFields.test.js`
Expected: PASS.

- [ ] **Step 5: Use the new helper in `admin/members.html`, removing the now-duplicated local logic**

Remove the local `const OPT_OUT_KEYS = ['dataSharingOptOut', 'photoOptOut'];` line — `renderAccountFieldInput` (imported below) now owns that logic internally via the exported `OPT_OUT_KEYS` in `formFields.js`, and this file no longer needs to reference the list directly, so don't import it here either.

Change the import line:
```javascript
import { escapeHtml, attachBirthdateFormatter, ACCOUNT_FIELD_LABELS, renderEventOptions, isOptOutYes, renderAccountFieldInput } from '/js/formFields.js';
```
(`isOptOutYes` may no longer be directly called in this file after this edit — check with a search after Steps 5-6 whether it's still used anywhere else in this file; if not, remove it from the import list too, don't leave an unused import.)

Replace `buildFieldInputs`'s map callback body:
```javascript
function buildFieldInputs(container, values = {}) {
  container.innerHTML = myAccountFields
    .filter((key) => key !== 'group')
    .map((key) => renderAccountFieldInput(key, ACCOUNT_FIELD_LABELS[key] ?? key, values[key]))
    .join('');
  const birthdateInput = container.querySelector('[data-field="birthdate"]');
  if (birthdateInput) attachBirthdateFormatter(birthdateInput);
}
```

Replace the editable branch inside `buildDetailFieldInputs`'s map callback:
```javascript
function buildDetailFieldInputs(container, values = {}) {
  const nameFieldsHtml = `
    <label for="field-firstName">Vorname</label>
    <input id="field-firstName" data-field="firstName" type="text" value="${escapeHtml(values.firstName ?? '')}">
    <label for="field-lastName">Nachname</label>
    <input id="field-lastName" data-field="lastName" type="text" value="${escapeHtml(values.lastName ?? '')}">
    <label for="field-nickname">Rufname</label>
    <input id="field-nickname" data-field="nickname" type="text" value="${escapeHtml(values.nickname ?? '')}">
  `;
  container.innerHTML = nameFieldsHtml + ALL_FIELD_KEYS.map((key) => {
    const label = ACCOUNT_FIELD_LABELS[key] ?? key;
    if (myAccountFields.includes(key)) {
      const sealedBadge = ' <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span></span>';
      return renderAccountFieldInput(key, label, values[key], { sealedBadge });
    }
    return `<label>${escapeHtml(label)}</label><p>${escapeHtml(values[key] ?? '–')}</p>`;
  }).join('');
  const birthdateInput = container.querySelector('[data-field="birthdate"]');
  if (birthdateInput) attachBirthdateFormatter(birthdateInput);
}
```
Note the leading space baked into `sealedBadge` here (`' <span...'`) — `renderAccountFieldInput`'s own template puts `${sealedBadge}` directly after the label text with no separating space, so the caller supplies it. This preserves the original rendered markup's spacing (`${escapeHtml(label)} <span class="sealed"...`) exactly.

- [ ] **Step 6: Manual verification — confirm zero behavior change**

Run the dev stack, open `admin/members.html`, and re-run this exact check from a previous session (do not skip — this is the task's real test, since it's a pure refactor):
1. Open the invite dialog, confirm `dataSharingOptOut`/`photoOptOut` still render as checkboxes and every other OT field as text, same as before.
2. Open an existing member's detail dialog, confirm the same, AND confirm the lock-icon "Verschlüsselt" badge still renders immediately after each permitted field's label with correct spacing (not `AdresseVerschlüsselt` run together, not a stray double space).
3. Toggle a checkbox and save; confirm the value round-trips correctly (reopen the dialog, checkbox state matches what you saved) — this exercises `data-field`/`.checked` reading in the existing save handlers, which Step 5 did not touch.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: every test passes (this task only touches shared frontend helpers + one page's internals; nothing here should affect any backend test, but confirm rather than assume).

- [ ] **Step 8: Commit**

```bash
git add frontend/js/formFields.js frontend/admin/members.html tests/unit/formFields.test.js
git commit -m "refactor: extract shared renderAccountFieldInput helper from admin/members.html"
```

---

### Task 3: Frontend — Bearbeiten-Dialog auf `admin/checkin.html`

**Files:**
- Modify: `frontend/admin/checkin.html`
- Modify: `frontend/js/formFields.js`

**Interfaces:**
- Consumes: `renderAccountFieldInput`, `OPT_OUT_KEYS`, `renderField`, `collectFieldValues` (all from `formFields.js`), `PATCH /members/:id`, `PUT /characters/:id` (Task 1) — all pre-existing or already extended.
- Produces: `renderField(field, value, idPrefix = '')` — signature widened with a new optional third parameter (backward compatible; every existing call site in the codebase omits it and keeps working identically).

- [ ] **Step 1: Widen `renderField`'s id generation to accept an optional prefix**

This is needed because the check-in dialog will render ONE `renderField` call per schema field PER character, and a participant can have more than one character for the same event (Ersatzcharaktere) — without a prefix, two characters sharing the same schema would produce duplicate `id`/`for` attributes in the same document, breaking label-click-to-focus association.

In `frontend/js/formFields.js`, change the `renderField` signature and its `id` line:
```javascript
export function renderField(field, value, idPrefix = '') {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key) + (field.required ? ' *' : '');
  const key = escapeHtml(field.key);
  const required = field.required ? 'required' : '';
  const id = `${idPrefix}field-${key}`;
```
Every other line in the function body already references `id` (not a hardcoded string), so no further changes are needed inside the function — the `${id}-${i}` multiselect-option ids further down already build on this same `id` variable and inherit the prefix automatically.

- [ ] **Step 2: Run the existing unit tests to confirm nothing broke**

Run: `node --test tests/unit/formFields.test.js`
Expected: PASS — every existing call to `renderField(field, value)` (two args) still produces identical output, since `idPrefix` defaults to `''`, reproducing today's exact `id="field-${key}"`.

- [ ] **Step 3: Add the dialog markup to `admin/checkin.html`**

Add, right after the existing `</dialog>` that closes `#scan-dialog`:
```html
<dialog id="edit-dialog">
  <h2 id="edit-dialog-title">Teilnehmer bearbeiten</h2>
  <div id="edit-ot-fields"></div>
  <div id="edit-characters"></div>
  <button type="button" id="edit-save">Speichern</button>
  <button type="button" id="edit-cancel" class="btn-ghost">Schließen</button>
</dialog>
```

- [ ] **Step 4: Import the newly-needed helpers**

Change the existing formFields.js import line:
```javascript
import { escapeHtml, formatFieldValue, ACCOUNT_FIELD_LABELS, STATUS_LABELS, renderEventOptions, renderAccountFieldInput, renderField, collectFieldValues } from '/js/formFields.js';
```

- [ ] **Step 5: Add an "Edit" button to the action cell, gated on there being something to edit**

Modify `renderActionCell(p)` — add one line near the end of the function, right before its `return parts.join(' ');`:
```javascript
function renderActionCell(p) {
  if (p.status === 'notified') {
    return canManageMembers ? `<button type="button" class="btn-ghost" data-cancel-invitation="${p.invitationId}">Absagen</button>` : '';
  }
  const parts = [];
  if (p.status === 'pending' && canOverride) {
    parts.push(`<button type="button" class="btn" data-approve="${p.userId}">Freigeben</button>`);
  }
  parts.push(`<button type="button" class="btn" data-checkin="${p.userId}" ${p.status !== 'confirmed' ? 'disabled' : ''}>Check-In</button>`);
  parts.push(`<button type="button" class="btn btn-ghost" data-checkout="${p.userId}" ${p.status !== 'checked_in' ? 'disabled' : ''}>Check-Out</button>`);
  if ((p.status === 'pending' || p.status === 'confirmed') && canOverride) {
    parts.push(`<button type="button" class="btn btn-ghost" data-cancel="${p.userId}">Absagen</button>`);
  }
  const canEditOt = Object.keys(p.otFields ?? {}).length > 0;
  const canEditCharacters = canOverride && (p.characters ?? []).length > 0;
  if (canEditOt || canEditCharacters) {
    parts.push(`<button type="button" class="btn-ghost" data-edit="${p.userId}">Bearbeiten</button>`);
  }
  return parts.join(' ');
}
```
Note: `canOverride` here is deliberately the SAME module-level flag already used for the status-override select (`account.canOverrideCheckinStatus`, set at page load) — this is exactly the permission this plan's Task 1 wired `PUT /characters/:id` to require, so reusing it here (rather than inventing a second flag) is intentionally correct, not a shortcut.

- [ ] **Step 6: Store participants in a module-level map so the edit dialog can look one up by id**

Add a new top-level `let`, next to the existing `let selectedColumns = { it: [], ot: [] };`:
```javascript
let participantsById = new Map();
```
In `loadParticipants`, right after the line `const participants = await api.get(...)`, add:
```javascript
participantsById = new Map(participants.map((p) => [p.userId, p]));
```

- [ ] **Step 7: Wire the new "Bearbeiten" button and write `openEditDialog`**

In `loadParticipants`, add alongside the other `listBody.querySelectorAll('[data-...]')` wiring blocks:
```javascript
listBody.querySelectorAll('[data-edit]').forEach((button) => {
  button.addEventListener('click', () => openEditDialog(button.dataset.edit));
});
```

Add the following near `openScanDialog` (same general area of the file). A module-level `editingUserId` tracks which participant the dialog is currently open for — the dialog markup itself has no `data-user-id` anywhere on it, so without this the save handler would have no way to know who to `PATCH`:
```javascript
const editDialog = document.getElementById('edit-dialog');
const editOtFields = document.getElementById('edit-ot-fields');
const editCharacters = document.getElementById('edit-characters');
let editingUserId = null;

function openEditDialog(userId) {
  const p = participantsById.get(userId);
  if (!p) return;
  editingUserId = userId;
  document.getElementById('edit-dialog-title').textContent = `Bearbeiten: ${p.name}`;

  const otKeys = Object.keys(p.otFields ?? {});
  editOtFields.innerHTML = otKeys.length > 0
    ? `<h3>Konto-Felder</h3>` + otKeys.map((key) => renderAccountFieldInput(key, ACCOUNT_FIELD_LABELS[key] ?? key, p.otFields[key])).join('')
    : '';

  editCharacters.innerHTML = canOverride
    ? (p.characters ?? []).map((c) => `
      <form class="checkin-character-form" data-character-id="${escapeHtml(c.id)}">
        <h3>${escapeHtml(c.name)}</h3>
        ${currentSchema.map((field) => renderField(field, c.data?.[field.key], `char-${c.id}-`)).join('')}
      </form>
    `).join('')
    : '';

  editDialog.showModal();
}

document.getElementById('edit-cancel').addEventListener('click', () => {
  editingUserId = null;
  editDialog.close();
});

document.getElementById('edit-save').addEventListener('click', async () => {
  message.textContent = '';
  message.className = '';
  const otPayload = {};
  editOtFields.querySelectorAll('[data-field]').forEach((input) => {
    otPayload[input.dataset.field] = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
  });
  const characterForms = [...editCharacters.querySelectorAll('.checkin-character-form')];
  try {
    if (Object.keys(otPayload).length > 0) {
      await api.patch(`/members/${editingUserId}`, otPayload);
    }
    for (const form of characterForms) {
      const data = collectFieldValues(form, currentSchema);
      await api.put(`/characters/${form.dataset.characterId}`, { data });
    }
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    editDialog.close();
    await loadParticipants(eventSelect.value);
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});
```
(The first, deliberately-broken version above exists only to make you read and understand the id-tracking problem before copying code — implement ONLY the corrected version. If you're reading this as an implementer: write the corrected version directly, don't transcribe the broken one first.)

- [ ] **Step 8: Manual verification**

Run the dev stack, log in as a user whose group has `canOverrideCheckinStatus: true` (e.g. seeded `admin` or `sl`) and has some `account_fields` granted (seeded `admin` has all of them; if testing as `sl`, first grant it `photoOptOut` via `admin/groups.html`, per this plan's own permission design — `sl` has zero `account_fields` by default), then on `admin/checkin.html`:
1. Confirm a "Bearbeiten" button appears on participant rows.
2. Open it; confirm OT fields render (checkbox for `photoOptOut`/`dataSharingOptOut`, text for others) and one section per character with that character's schema fields pre-filled with current values.
3. Toggle `photoOptOut` on, save; confirm the dialog closes, the row refreshes, and reopening the dialog shows the checkbox still checked (round-trip through `PATCH /members/:id`).
4. Change a character field, save; confirm it round-trips the same way, AND confirm no OTHER character field silently went blank (the exact regression this plan's Global Constraints section calls out — check the character's full data via `admin/members.html`'s member detail if easier, or by reopening this same dialog).
5. Log in as a group with `canOverrideCheckinStatus: false` and zero relevant `account_fields` (e.g. seeded `sc` or `nsc`, if they can even reach `checkin` — otherwise a group like `plot_orga`); confirm the "Bearbeiten" button does NOT appear for any row where there's nothing that group can edit.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: every test passes.

- [ ] **Step 10: Commit**

```bash
git add frontend/admin/checkin.html frontend/js/formFields.js
git commit -m "feat: add ad-hoc OT/IT field editing dialog to admin/checkin.html"
```

---

### Task 4: Full test suite

**Files:** None (verification-only task).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test in the project passes. Mandatory final gate.

- [ ] **Step 2: Commit if Step 1 required fixes**

If Step 1 was already green, skip this step. Otherwise:
```bash
git add -A
git commit -m "fix: address full-suite failures found after check-in ad-hoc editing work"
```
