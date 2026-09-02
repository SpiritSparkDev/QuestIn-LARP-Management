# Konto & Charaktere UI-Verbesserungen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the participant-facing pages (`account.html`, `characters.html`) a consistent icon system, a redesigned logout control, a visible encryption-hint icon with tooltip, a responsive account-form layout, and live client-side validation feedback — all with native platform features, no new dependency.

**Architecture:** Material Symbols loaded via a Google Fonts CDN `<link>` (identical mechanism to the fonts every page already loads — no script, no npm package). A small set of new, reusable CSS rules in `chronicle-crest.css`. One new shared JS helper (`attachLiveValidation`) in `frontend/js/formFields.js`, following that file's existing pattern of small, composable, framework-free helpers.

**Tech Stack:** Vanilla JS, vanilla CSS, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-ui-verbesserungen-design.md` (Teil 1)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies. Icons are a CDN font stylesheet, not a script — matches the existing Google Fonts precedent exactly.
- The LAST task must run the full `npm test` suite as an explicit step.
- Never call `applyBranding()` with a blocking top-level `await` — this bug class has been found and fixed multiple times this session. This plan adds no new top-level awaits; if any task's changes land near the existing `applyBranding();` call, confirm it stays un-awaited and still fires before any listener registration.
- Every new interactive icon must remain a real `<button>`/`<a>`, never a bare `<span>` with a click handler — icons are decoration on top of a real control, not a replacement for one (matches this project's existing accessibility posture, e.g. every existing button already has real text content).

---

### Task 1: Icon system + logout button redesign

**Files:**
- Modify: `frontend/css/chronicle-crest.css`
- Modify: `frontend/account.html`
- Modify: `frontend/characters.html`

**Interfaces:**
- Produces: `.material-symbols-outlined` (base icon styling), `.icon-btn` (a button that is primarily an icon, hover-scale), `.btn-danger` (red/warning button variant) — all new CSS classes, usable by any future page without re-declaring them.

- [ ] **Step 1: Add the Material Symbols stylesheet link**

In BOTH `frontend/account.html` and `frontend/characters.html`, add one line in `<head>`, right after the existing Google Fonts `<link rel="stylesheet" ...>` line (before `<link rel="stylesheet" href="/css/chronicle-crest.css">`):

```html
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
```

- [ ] **Step 2: Add the icon and button CSS**

Read `frontend/css/chronicle-crest.css` first (140 lines, shown in full in this plan's own research). Add these rules after the existing `.btn-ghost` rule (line 95), before `.divider-word`:

```css
.material-symbols-outlined{
  font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 20;
  font-size:20px; vertical-align:middle; line-height:1; user-select:none;
}
.icon-btn{
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  background:none; border:none; cursor:pointer; padding:6px; border-radius:6px;
  color:var(--on-surface-variant); transition:transform 0.12s ease, color 0.12s ease;
}
.icon-btn:hover{ transform:scale(1.15); color:var(--primary-deep); }
.btn-danger{
  font-family:"Work Sans",sans-serif; font-size:14px; font-weight:600;
  background:transparent; color:var(--error); border:1.5px solid var(--error);
  padding:9px 18px; border-radius:6px; cursor:pointer;
  display:inline-flex; align-items:center; gap:6px;
}
.btn-danger:hover{ background:var(--error); color:var(--surface); }
.header-actions{ position:absolute; top:40px; right:44px; }
@media (max-width:600px){
  .header-actions{ position:static; text-align:right; margin-bottom:16px; }
  .btn-danger{ padding:7px 14px; font-size:13px; }
}
```

(`.header-actions` is positioned `absolute` relative to `.folio`, which already has `position:relative` — line 37 of the existing file. On narrow screens it falls back to `static`/right-aligned so it doesn't overlap the heading text, per the spec's "auf Mobile-Geräten angepasste Größe" requirement.)

- [ ] **Step 3: Redesign the logout control on `account.html`**

Read the current file first (162 lines, shown in full in this plan's own research). Change:

```html
    <nav class="app-nav" id="nav-links"></nav>
    <a href="#" id="logout-link">Logout</a>
    <h1>Mein Konto</h1>
```

to:

```html
    <nav class="app-nav" id="nav-links"></nav>
    <div class="header-actions">
      <button type="button" id="logout-link" class="btn-danger">
        <span class="material-symbols-outlined" aria-hidden="true">logout</span> Logout
      </button>
    </div>
    <h1>Mein Konto</h1>
```

In the `<script type="module">` block, the existing listener already works unchanged for a `<button>` (it was only ever using `evt.preventDefault()` and a click listener, neither of which depends on the element being an `<a>`) — but `preventDefault()` on a `<button type="button">` click is a harmless no-op, not a requirement, so simplify it slightly:

```javascript
document.getElementById('logout-link').addEventListener('click', async () => {
  if (!confirm('Wirklich abmelden?')) return;
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});
```

- [ ] **Step 4: Redesign the logout control on `characters.html`**

Read the current file first (this plan's own research shows the header block above — the rest of the file is unaffected). Apply the identical change as Step 3 (same markup replacement, same script change) — `characters.html`'s existing logout listener has the exact same shape as `account.html`'s did before Step 3.

- [ ] **Step 5: Manual verification**

Start the dev server, use the Browser tool: navigate to `/account.html` and `/characters.html` (logged in as any test user). Confirm the logout button renders top-right with the logout icon, red outline styling, and a hover-scale effect on the icon. Click it and confirm the native "Wirklich abmelden?" confirmation appears; cancel it and confirm you stay logged in; confirm it again and confirm you're actually logged out. Resize the browser to a narrow (mobile) width and confirm the button repositions sensibly rather than overlapping the heading. Screenshot both states (desktop, mobile) as evidence.

- [ ] **Step 6: Commit**

```bash
git add frontend/css/chronicle-crest.css frontend/account.html frontend/characters.html
git commit -m "feat: add Material Symbols icon system, redesign logout button"
```

---

### Task 2: Encryption-hint icon and tooltip

**Files:**
- Modify: `frontend/css/chronicle-crest.css`
- Modify: `frontend/account.html`
- Modify: `frontend/admin/members.html`

**Interfaces:**
- Consumes: `.material-symbols-outlined` from Task 1.

- [ ] **Step 1: Load Material Symbols on `admin/members.html` too**

This page doesn't get Task 1's other changes (it's an admin/`everest-registry.css` page, out of this plan's scope per the spec — only its encrypted-field labels need an icon). Read the current file first (309 lines, shown in full in this plan's own research). Add one line in `<head>`, right after the existing Google Fonts `<link rel="stylesheet" ...>` line:

```html
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
```

`.material-symbols-outlined`'s CSS rule lives in `chronicle-crest.css` (Task 1), which this page does NOT load — add the identical rule to `frontend/css/everest-registry.css` too, so the icon renders correctly here (read that file first to place it sensibly near its other small utility rules):

```css
.material-symbols-outlined{
  font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 20;
  font-size:16px; vertical-align:middle; line-height:1; user-select:none;
}
```

(Font size is 16px here, not Task 1's 20px — this page's `.sealed`-equivalent labels sit in a denser admin table/form context; match the size to the surrounding 13-15px text this file already uses elsewhere, adjusting the exact value if 16px looks visually off once rendered.)

- [ ] **Step 2: Add the lock icon and tooltip to every encrypted-field label**

In `frontend/account.html`, there are 7 occurrences of the exact pattern `<span class="sealed">Verschlüsselt</span>`. Change every one to:

```html
<span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span> Verschlüsselt</span>
```

(All 7 occurrences get the identical replacement — this is a mechanical find-and-replace-all across the one file, not 7 separately-reasoned edits.)

In `frontend/admin/members.html`, the equivalent encrypted-field labels are generated in JS, not static HTML — `buildDetailFieldInputs()`'s per-field label line:

```javascript
      return `<label for="field-${key}">${escapeHtml(label)}</label><input id="field-${key}" data-field="${key}" type="text" value="${escapeHtml(values[key] ?? '')}">`;
```

This label does NOT currently say "Verschlüsselt" at all — it's just the field's plain label (e.g. "Adresse"). Add the same icon+tooltip treatment, but only for fields that are ACTUALLY encrypted server-side (every key in `ACCOUNT_FIELD_LABELS` except none — read `backend/accounts/repository.js`'s `decryptAccount` first to confirm every one of `ACCOUNT_FIELD_LABELS`'s keys — `address`, `birthdate`, `phone`, `emergencyContactLastName`, `emergencyContactFirstName`, `emergencyContactPhone`, `medicalNotes` — really is one of the `decryptField(...)`-wrapped columns before assuming this, since a label list drifting out of sync with actual encryption would make this icon misleading):

```javascript
      return `<label for="field-${key}">${escapeHtml(label)} <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span></span></label><input id="field-${key}" data-field="${key}" type="text" value="${escapeHtml(values[key] ?? '')}">`;
```

(No "Verschlüsselt" text here, icon-only with a tooltip — this context is already a labeled input in a dense admin form, unlike `account.html`'s more spacious layout; the tooltip carries the explanation, matching the spec's acceptance criterion of a tooltip explanation without requiring the visible text label to also grow.)

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: navigate to `/account.html`, confirm all 7 encrypted fields show a lock icon before "Verschlüsselt" and that hovering shows the tooltip text (check via `title` attribute presence in `read_page`, since a real hover-tooltip render isn't reliably screenshot-able). Navigate to `/admin/members.html` as an admin, open a member's edit dialog, confirm the same lock icon+tooltip appears next to each encrypted field's label. Screenshot both pages.

- [ ] **Step 4: Commit**

```bash
git add frontend/css/chronicle-crest.css frontend/css/everest-registry.css frontend/account.html frontend/admin/members.html
git commit -m "feat: add lock icon and tooltip to encrypted-field labels"
```

---

### Task 3: Responsive account-form layout

**Files:**
- Modify: `frontend/css/chronicle-crest.css`
- Modify: `frontend/account.html`

**Interfaces:** None (pure layout/CSS change; no new function signatures).

- [ ] **Step 1: Wrap the form's fields in grouped, grid-friendly sections**

Read `account.html` as it now stands after Tasks 1-2 (its `<form id="account-form">` still has the same field set, just with icon-decorated `.sealed` spans). Restructure the form body into three `<div class="field-grid">` groups — name fields, contact fields, emergency-contact fields — plus the standalone `medicalNotes` textarea (which spans full width regardless of column count, since a textarea in a 2-column grid looks cramped):

```html
    <form id="account-form">
      <div class="field-grid">
        <div><label for="firstName">Vorname</label><input id="firstName" name="firstName" type="text" required></div>
        <div><label for="lastName">Nachname</label><input id="lastName" name="lastName" type="text" required></div>
        <div><label for="nickname">Rufname</label><input id="nickname" name="nickname" type="text"></div>
      </div>
      <div class="field-grid">
        <div><label for="address">Adresse <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span> Verschlüsselt</span></label><input id="address" name="address" type="text"></div>
        <div><label for="birthdate">Geburtsdatum <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span> Verschlüsselt</span></label><input id="birthdate" name="birthdate" type="text" placeholder="TT.MM.JJJJ"></div>
        <div><label for="phone">Telefon <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span> Verschlüsselt</span></label><input id="phone" name="phone" type="text"></div>
      </div>
      <div class="field-grid">
        <div><label for="emergencyContactLastName">Notfallkontakt: Name <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span> Verschlüsselt</span></label><input id="emergencyContactLastName" name="emergencyContactLastName" type="text"></div>
        <div><label for="emergencyContactFirstName">Notfallkontakt: Vorname <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span> Verschlüsselt</span></label><input id="emergencyContactFirstName" name="emergencyContactFirstName" type="text"></div>
        <div><label for="emergencyContactPhone">Notfallkontakt: Telefonnummer <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span> Verschlüsselt</span></label><input id="emergencyContactPhone" name="emergencyContactPhone" type="text"></div>
      </div>
      <label for="medicalNotes">Gesundheitshinweise / Allergien <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span> Verschlüsselt</span></label>
      <textarea id="medicalNotes" name="medicalNotes"></textarea>
      <button type="submit">Speichern</button>
    </form>
```

(This restructuring changes the DOM nesting — each field is now inside its own `<div>` inside a `.field-grid` wrapper, rather than a flat sequence of `<label>`/`<input>` siblings directly inside `<form>`. Confirm this doesn't break anything relying on flat sibling structure: `loadAccount()`'s `form.elements[field].value = ...` loop uses the FORM's `.elements` collection, which includes every named form control regardless of DOM nesting depth — unaffected by this change. `formControls = form.querySelectorAll('input, textarea, button')` similarly matches by tag, not position — also unaffected. Verify both of these claims against the actual current script block before treating this restructuring as safe, rather than assuming.)

- [ ] **Step 2: Add the grid CSS**

Add to `frontend/css/chronicle-crest.css`, near the existing `.char-grid` rule (which already establishes this file's exact breakpoint convention — reuse the same `560px` breakpoint value for consistency, per the spec's "logische Gruppierung" and "1-Spalte Mobile, 2-Spalten Desktop" requirements):

```css
.field-grid{ display:grid; grid-template-columns:1fr 1fr; gap:0 24px; }
@media (max-width:560px){ .field-grid{ grid-template-columns:1fr; } }
```

(`gap:0 24px` — zero row-gap because each field's own `label`/`input` vertical spacing already comes from the existing `label{ margin:22px 0 8px; }` rule; only a horizontal column-gap is new. The name-fields group has 3 items in a 2-column grid, so the third field wraps to its own row — acceptable and matches the spec's "logische Gruppierung" intent more than forcing an awkward 3-column layout would.)

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: navigate to `/account.html` at a desktop width, confirm fields render in a 2-column grid grouped as designed. Resize to a narrow width, confirm it collapses to 1 column. Submit the form with changed values and confirm saving still works (proving Step 1's DOM-nesting change didn't break the save path). Screenshot both widths.

- [ ] **Step 4: Commit**

```bash
git add frontend/css/chronicle-crest.css frontend/account.html
git commit -m "feat: responsive grid layout for the account form"
```

---

### Task 4: Client-side validation feedback

**Files:**
- Modify: `frontend/js/formFields.js`
- Modify: `frontend/account.html`
- Modify: `frontend/characters.html`

**Interfaces:**
- Produces: `attachLiveValidation(formEl)` (new export from `frontend/js/formFields.js`) — attaches `input`/`blur` listeners to every form control in `formEl`, toggling an `.invalid` class and a sibling `.field-error` message based on native `checkValidity()`. Call once per form after it exists in the DOM; safe to call on a form whose fields are still being populated (see Step 1's "hasInteracted" reasoning).

- [ ] **Step 1: Write the helper**

Read `frontend/js/formFields.js` first (82 lines, shown in full in this plan's own research — a file of small, focused, exported helpers; this fits that established shape). Add this new export:

```javascript
// Shows a field's native validation message only after the user has
// actually interacted with it -- otherwise every required-but-empty field
// on a freshly-loaded form would show as invalid immediately, before the
// user has had any chance to fill it in.
export function attachLiveValidation(formEl) {
  const controls = formEl.querySelectorAll('input, select, textarea');
  controls.forEach((el) => {
    let hasInteracted = false;
    const errorEl = document.createElement('p');
    errorEl.className = 'field-error';
    el.insertAdjacentElement('afterend', errorEl);

    function refresh() {
      if (!hasInteracted) return;
      const valid = el.checkValidity();
      el.classList.toggle('invalid', !valid);
      errorEl.textContent = valid ? '' : el.validationMessage;
    }

    el.addEventListener('blur', () => { hasInteracted = true; refresh(); });
    el.addEventListener('input', refresh);
  });
}
```

(`errorEl` is inserted once per control at attach time, not created fresh on every `input` event — cheap, and avoids re-inserting/removing a DOM node on every keystroke. `insertAdjacentElement('afterend', ...)` places it immediately after the input, which in this project's current label-after-input DOM order means it lands between the input and its own label — verify this rendering position looks acceptable once implemented; if it visually clashes with the label, moving the error element to render after the label instead — e.g. targeting the input's `nextElementSibling` when that's the `<label>` — is an acceptable adjustment, but only make it if the plain `afterend` placement actually looks wrong once rendered, not preemptively.)

- [ ] **Step 2: Add the validation CSS**

Add to `frontend/css/chronicle-crest.css`, near the existing `input:focus` rule:

```css
input.invalid, select.invalid, textarea.invalid{ border-bottom-color:var(--error); border-bottom-width:2px; }
.field-error{ color:var(--error); font-size:12px; margin:2px 0 0; min-height:14px; }
```

(`.field-error`'s `min-height` keeps layout from jumping when a message appears/disappears — a small, deliberate detail, not required by the spec but cheap and avoids a jarring reflow on every keystroke.)

- [ ] **Step 3: Wire it into `account.html` and `characters.html`**

In `account.html`'s script block, add the import and one call, right after the existing `attachBirthdateFormatter(...)` line:

```javascript
import { attachBirthdateFormatter, attachLiveValidation } from '/js/formFields.js';
```
```javascript
attachLiveValidation(form);
```

In `characters.html`, add the same import (merge into the existing `import { escapeHtml, renderField, collectFieldValues } from '/js/formFields.js';` line) and call it on BOTH the SC character form and the NSC character form, right after each form's own `const ... = document.getElementById(...)` setup — read the current file fresh to place these two calls correctly (`attachLiveValidation(form);` for the SC form, `attachLiveValidation(nscForm);` for the NSC form).

- [ ] **Step 4: Add required-field markers**

In `frontend/account.html`'s static markup, the only two `required` fields are `firstName` and `lastName` — change their label text directly:

```html
<label for="firstName">Vorname *</label>
```
```html
<label for="lastName">Nachname *</label>
```

For schema-driven fields (`characters.html`'s dynamic forms, via `formFields.js`'s `renderField`), read the current function first (Steps in this plan's own research show it in full). Every branch that builds a `label` variable and outputs it needs the marker appended when `field.required` is true. Change the top of `renderField`:

```javascript
export function renderField(field, value) {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key) + (field.required ? ' *' : '');
  const key = escapeHtml(field.key);
  const required = field.required ? 'required' : '';
  const id = `field-${key}`;
```

(One-line change at the top of the function — every branch below already uses the `label` variable for its output, so the marker propagates to all of them automatically; no branch needs its own edit. `field.label` is escaped BEFORE the marker is appended, so `' *'` — plain ASCII, never attacker-controlled — cannot be affected by or interfere with the escaping.)

- [ ] **Step 5: Run the existing unit tests for `formFields.js`**

Run: `node --test tests/unit/formFields.test.js`
Expected: all PASS. If the `renderField` label change breaks any existing assertion that checks exact label text without accounting for a possible trailing `' *'`, that test's OWN required-field fixture is what changed observable behavior for — confirm any such failure is a genuine, expected update to reflect the new marker (not a sign the change broke something), and update the assertion to match, matching this project's established practice of investigating rather than assuming when an existing test's expectation shifts.

- [ ] **Step 6: Manual verification**

Start the dev server, use the Browser tool: navigate to `/account.html`, confirm "Vorname"/"Nachname" show a trailing `*`. Clear the Vorname field and blur it (click elsewhere); confirm a red-bordered field and an error message appear. Type a value back in; confirm the error clears live as you type (not just on the next blur). Navigate to `/characters.html`, open the character-creation form, confirm required schema fields (if any exist in the default schema) show the `*` marker and the same live-validation behavior. Screenshot the invalid-state rendering.

- [ ] **Step 7: Commit**

```bash
git add frontend/js/formFields.js frontend/css/chronicle-crest.css frontend/account.html frontend/characters.html
git commit -m "feat: add live client-side validation feedback and required-field markers"
```

---

### Task 5: Full test suite

**Files:** None (verification-only task).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test in the project passes. Mandatory final gate.

- [ ] **Step 2: Commit if Step 1 required fixes**

If Step 1 was already green, skip this step. Otherwise:
```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

## Self-Review Notes

- Spec coverage: covers Teil 1 of `2026-09-02-ui-verbesserungen-design.md` in full — the Material Symbols icon system (1.1), the logout redesign (1.2), the encryption-hint icon/tooltip (1.3), the responsive form grid (1.4), and live client-side validation with required-field markers (1.5).
- Type/interface consistency: `.material-symbols-outlined`/`.icon-btn`/`.btn-danger`/`.field-grid`/`.field-error`/`.invalid` are each defined exactly once (Tasks 1-4, in that order) and consumed by name in every later task without redefinition — no class-name drift between the CSS and the HTML/JS that references it.
- Blast-radius discipline, learned from this project's own repeated history of "a task's own file list missed a real consumer": Task 2 explicitly checks `ACCOUNT_FIELD_LABELS`' keys against `decryptAccount`'s actual encrypted columns before applying the lock icon, rather than assuming the label list is accurate; Task 3 explicitly names the exact two places (`form.elements[...]` access, `querySelectorAll` by tag) that could have broken from a DOM-nesting change and states why they don't, rather than leaving that unverified.
- No new top-level `await` introduced anywhere in this plan — every task's script changes are either synchronous (Tasks 1-3) or a plain function call with no `await` at all (`attachLiveValidation(form);` in Task 4).
