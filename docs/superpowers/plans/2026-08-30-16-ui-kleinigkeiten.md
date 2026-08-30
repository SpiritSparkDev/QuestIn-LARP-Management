# UI-Kleinigkeiten Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three small, independent frontend UX fixes: auto-formatting the birthdate field while typing, converting the group-edit form into a modal dialog, and moving character-form field labels below their inputs instead of above.

**Architecture:** Each fix touches a different, disjoint set of files with no shared interface between them — three unrelated small changes bundled into one plan because each is too small to warrant its own plan/worktree cycle.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, vanilla JS frontend, no build step, no new npm dependencies. Task 2 uses the native HTML `<dialog>` element (no library).

**Spec:** `docs/superpowers/specs/2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` (Teil 1: UI-Kleinigkeiten)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step — standing rule for every plan in this sequence.
- No behavior change to any existing test's assertions — these are pure UI/UX changes; if any existing test currently asserts something about the touched markup, it must still pass unchanged unless the task explicitly says to update it.
- There is no DOM test framework in this project (established convention) — frontend changes are verified by reading the logic and, where practical, via the Browser tool live against the dev server; this is not a gap to fill.

---

### Task 1: Geburtsdatum-Autoformatierung

**Files:**
- Modify: `frontend/js/formFields.js`
- Modify: `frontend/account.html`
- Modify: `frontend/admin/members.html`

**Interfaces:**
- Produces: `export function attachBirthdateFormatter(inputEl)` from `frontend/js/formFields.js` — attaches an `input` event listener to `inputEl` that reformats its value live. No return value. Idempotent to call multiple times on the same element (attaching the listener twice is harmless since each call just re-runs the same formatting logic on future input events; not deduplicated, callers should call it once per element).

- [ ] **Step 1: Add the formatter to `frontend/js/formFields.js`**

Add this function anywhere in the file (e.g. after `escapeHtml`, before `renderField`):

```javascript
export function attachBirthdateFormatter(inputEl) {
  inputEl.addEventListener('input', () => {
    const digits = inputEl.value.replace(/\D/g, '').slice(0, 8);
    let formatted = digits.slice(0, 2);
    if (digits.length > 2) formatted += `.${digits.slice(2, 4)}`;
    if (digits.length > 4) formatted += `.${digits.slice(4, 8)}`;
    inputEl.value = formatted;
  });
}
```

- [ ] **Step 2: Apply it in `frontend/account.html`**

The birthdate input is `<input id="birthdate" name="birthdate" type="text" placeholder="TT.MM.JJJJ">` (line 25). Add the import and call it once at module load. Change:
```javascript
import { api } from '/js/api.js';
import { renderNavLinks } from '/js/nav.js';
```
to:
```javascript
import { api } from '/js/api.js';
import { renderNavLinks } from '/js/nav.js';
import { attachBirthdateFormatter } from '/js/formFields.js';
```
and add this line right after `const formControls = form.querySelectorAll('input, textarea, button');` (so it runs once, at module init, same as the rest of the module-level setup):
```javascript
attachBirthdateFormatter(document.getElementById('birthdate'));
```

- [ ] **Step 3: Apply it in `frontend/admin/members.html`**

This file renders birthdate inputs dynamically (one key among several in `buildFieldInputs`/`buildDetailFieldInputs`, both driven by looping over field keys — read the file's current content first, it was last touched in Plan 4 of a previous initiative and its exact current line numbers may differ from what's quoted here). Add the import:
```javascript
import { api } from '/js/api.js';
import { escapeHtml } from '/js/formFields.js';
import { renderNavLinks } from '/js/nav.js';
```
becomes:
```javascript
import { api } from '/js/api.js';
import { escapeHtml, attachBirthdateFormatter } from '/js/formFields.js';
import { renderNavLinks } from '/js/nav.js';
```

In `buildFieldInputs(container, values = {})`, after setting `container.innerHTML = ...`, add:
```javascript
const birthdateInput = container.querySelector('[data-field="birthdate"]');
if (birthdateInput) attachBirthdateFormatter(birthdateInput);
```
so the full function becomes:
```javascript
function buildFieldInputs(container, values = {}) {
  container.innerHTML = myAccountFields
    .filter((key) => key !== 'group')
    .map((key) => `
      <label for="field-${key}">${escapeHtml(ACCOUNT_FIELD_LABELS[key] ?? key)}</label>
      <input id="field-${key}" data-field="${key}" type="text" value="${escapeHtml(values[key] ?? '')}">
    `).join('');
  const birthdateInput = container.querySelector('[data-field="birthdate"]');
  if (birthdateInput) attachBirthdateFormatter(birthdateInput);
}
```

Apply the identical two-line addition (query for `[data-field="birthdate"]` on the container, attach if found) at the end of `buildDetailFieldInputs(container, values = {})`, right after its `container.innerHTML = ...` assignment — that function's body is a `.map(...).join('')` assigned directly to `container.innerHTML`, so add the same two lines immediately after that assignment statement, before the function returns.

- [ ] **Step 4: Manual verification**

Start the dev server (`docker compose up -d` from the repo root, or reuse a running instance) and use the Browser tool: navigate to `/account.html`, log in, click into the birthdate field, type `29011991` character by character, confirm it renders as `29.01.1991` live. Repeat on `/admin/members.html`'s invite form and a member's detail-edit view (as an admin user). Take a screenshot as evidence.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/formFields.js frontend/account.html frontend/admin/members.html
git commit -m "feat: auto-format birthdate field while typing"
```

---

### Task 2: Gruppe bearbeiten als Pop-up

**Files:**
- Modify: `frontend/admin/groups.html`

**Interfaces:**
- None consumed or produced beyond this file — purely internal restructuring of one page.

- [ ] **Step 1: Wrap the form in a `<dialog>`**

Read the current file first (it was last touched two initiatives ago; confirm line numbers before editing). Replace the form's containing markup — currently:
```html
    <div class="card form-pad">
      <h2 id="form-title">Neue Gruppe anlegen</h2>
      <form id="group-form">
```
...(unchanged field markup in between)...
```html
        <button type="submit">Speichern</button>
        <button type="button" id="cancel-edit" style="display:none;" class="btn-ghost">Abbrechen</button>
      </form>
    </div>
```
with:
```html
    <button type="button" id="open-create">Neue Gruppe anlegen</button>
    <dialog id="group-dialog">
      <h2 id="form-title">Neue Gruppe anlegen</h2>
      <form id="group-form">
```
...(unchanged field markup in between, keep every field exactly as-is)...
```html
        <button type="submit">Speichern</button>
        <button type="button" id="cancel-edit" class="btn-ghost">Abbrechen</button>
      </form>
    </dialog>
```
(The `style="display:none;"` on the Abbrechen button is removed — inside a closed `<dialog>` nothing is visible anyway, and once the dialog is open both Speichern and Abbrechen should always show, matching both the create and edit case, unlike the old inline-form design where Abbrechen only made sense once editing had started.)

- [ ] **Step 2: Update the script — open/close the dialog instead of show/hide inline**

Read the script section fully first. Add a reference to the new button and dialog near the other `const ... = document.getElementById(...)` lines:
```javascript
const openCreateButton = document.getElementById('open-create');
const dialog = document.getElementById('group-dialog');
```

In `startEdit(group)`, add `dialog.showModal();` as the last line of the function (after everything else it already does — the function's existing body of setting `formTitle`, `nameInput.value`, etc. stays completely unchanged, just add one line at the end).

In `resetForm()`, add `dialog.close();` as the last line — but ONLY when the dialog is actually open (calling `.close()` on an already-closed native `<dialog>` is a harmless no-op per the HTML spec, so no guard is needed; just add the line unconditionally at the end of the function).

Add a new listener for the create button, right after the existing `cancelButton.addEventListener('click', resetForm);` line:
```javascript
openCreateButton.addEventListener('click', () => {
  resetForm();
  dialog.showModal();
});
```
(`resetForm()` already sets the title back to "Neue Gruppe anlegen" and clears the form — calling it before opening ensures a stale edit-state never leaks into a fresh "create" open.)

In the form's `submit` handler, after the existing success path already calls `resetForm();` (which will now also close the dialog per Step 2's `resetForm` change) — no other change needed there, `resetForm()` already runs on success and the dialog closing is now just a side effect of that same call.

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: navigate to `/admin/groups.html` as an admin, confirm the group list and page load without the form visible inline. Click "Neue Gruppe anlegen" — dialog opens as a modal (background dimmed/inert, matches native `<dialog>`'s default `::backdrop` behavior). Click "Abbrechen" — dialog closes. Click "Bearbeiten" on an existing group — dialog opens pre-filled with that group's values. Save a change — dialog closes and the list reflects the update. Screenshot at least one open-dialog state as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/groups.html
git commit -m "feat: edit group in a modal dialog instead of an inline form"
```

---

### Task 3: Feldbezeichnungen unter das Feld (Charakter-Formulare)

**Files:**
- Modify: `frontend/js/formFields.js`
- Modify: `frontend/css/chronicle-crest.css`

**Interfaces:**
- Modifies: `renderField(field, value)`'s return markup (label/input order swapped) — consumed by `frontend/characters.html`'s `#dynamic-fields`/`#nsc-dynamic-fields` containers only (confirmed via grep: `renderField` is imported and called nowhere else in the frontend). No signature or return-type change, only the HTML string's internal element order.

This task is scoped ONLY to the schema-driven character form (`characters.html`, via `formFields.js`'s `renderField`) — the user's feedback named `/characters.html` specifically. Do not touch `account.html`, `admin/members.html`, or `admin/groups.html`'s hand-authored forms; their labels stay exactly where they are.

- [ ] **Step 1: Swap label/input order in every branch of `renderField`**

Read the current `renderField` function in `frontend/js/formFields.js` first to confirm it matches what's below (it was last touched when the `link` field type doesn't exist yet — this task predates Plan 4's `link` type, so only the 5 branches below exist: `boolean`, `multiselect`, `number`, `textarea`, `select`, plus the default `text` fallback). Replace the whole function body, keeping every attribute/class/escaping exactly as it is — only reordering which HTML fragment comes first in each returned template string:

```javascript
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
    return `<input id="${id}" name="${key}" type="number" value="${val}" ${required}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'textarea') {
    return `<textarea id="${id}" name="${key}" ${required}>${val}</textarea><label for="${id}">${label}</label>`;
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    const blankOption = field.required ? '' : '<option value=""></option>';
    const options = field.options.map((opt) => {
      const escapedOpt = escapeHtml(opt);
      const selected = opt === value ? ' selected' : '';
      return `<option value="${escapedOpt}"${selected}>${escapedOpt}</option>`;
    }).join('');
    return `<select id="${id}" name="${key}" ${required}>${blankOption}${options}</select><label for="${id}">${label}</label>`;
  }
  return `<input id="${id}" name="${key}" type="text" value="${val}" ${required}><label for="${id}">${label}</label>`;
}
```

Note: the `boolean` and `multiselect` branches are deliberately left UNCHANGED — a checkbox's label conventionally sits beside/after it already (that's what `<label><input>...text</label>` already produces), and the user's request ("Feldbezeichnungen unter das Feld") is about text-like inputs, not checkbox rows. Only `number`, `textarea`, `select`, and the default `text` branch had their label-before-input order changed to input-before-label.

- [ ] **Step 2: Add the CSS to actually position the (now-reordered) label below its input**

`frontend/css/chronicle-crest.css` currently has a global `label{ display:block; ... margin:22px 0 8px; }` rule (used by every hand-authored form on `account.html`, `login.html`, etc.) — do NOT change that global rule, it must keep working for every other page. Instead, add a new, scoped rule right after it, targeting only the two dynamic-fields containers on `characters.html`:

```css
#dynamic-fields label, #nsc-dynamic-fields label{ margin:4px 0 18px; }
```

(This overrides just the `margin` for labels inside those two containers — since the DOM order is now input-then-label, a small top margin plus larger bottom margin visually separates "this label belongs to the input above it" from "the next field's input below it", instead of the global rule's top-heavy spacing which was written for the old label-then-input order.)

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: navigate to `/characters.html` as a user whose group can create SC characters, open the character-creation form, confirm every text/number/textarea/select field in the dynamic schema section shows its label directly below the input, with checkboxes (boolean fields, if the active event's schema has one) still showing their label beside them as before. Screenshot as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/js/formFields.js frontend/css/chronicle-crest.css
git commit -m "feat: move character-form field labels below their inputs"
```

---

### Task 4: Full test suite

**Files:** None (verification-only task).

**Interfaces:** None.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test in the project passes (this plan makes no backend changes and no changes to any tested frontend module's exported function signatures other than adding one new export and reordering HTML string content inside `renderField`'s return value, which no existing test asserts on character-by-character — confirm this by checking `tests/unit/formFields.test.js`'s current assertions before running, and if any assertion does check exact label/input ordering in `renderField`'s output, update that one assertion to match the new order in this same task, then re-run).

- [ ] **Step 2: Commit if Step 1 required a test update**

If Step 1 was already green with no changes needed, skip this step. Otherwise:
```bash
git add tests/unit/formFields.test.js
git commit -m "test: update formFields test for label/input reorder"
```

## Self-Review Notes

- Spec coverage: covers Teil 1 of `2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` in full (all three sub-items: birthdate autoformat, group popup, label position).
- Task 3's scope was deliberately narrowed to `characters.html` only (matching the spec's own scoping to `formFields.js`'s `renderField`), not applied to every form in the app — the spec's Teil 1.3 already makes this scope explicit, this plan just makes the file-level consequence (don't touch `account.html`/`admin/members.html`/`admin/groups.html`'s own labels) explicit for the implementer too.
- Type/interface consistency: `attachBirthdateFormatter(inputEl)` is used identically in both call sites (Task 1, Steps 2 and 3) — same signature, same "call once per element" contract.
