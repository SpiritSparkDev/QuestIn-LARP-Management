# Anmeldung/Check-In/Schema Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement seven independent pieces of user feedback: remove the self-service "Wie kommst du?" mode selector from registration, make events deletable, restrict the check-in event dropdown to the active event, harden the check-in scan dialog's Enter-key focus handling, add drag-free up/down field reordering to the character-schema editor, add a per-field "staff only" edit lock for character schema fields, and add an admin on/off switch for the "Charaktere durchsuchen" page.

**Architecture:** No new subsystems. Each item is a small, additive change to existing routes/pages: one new `DELETE /events/:id` route, one new `app_settings` column + admin toggle, one new character-schema field flag enforced both client- and server-side, and several frontend-only simplifications. Bounded scope per the brainstorming classification — no separate spec doc.

**Tech Stack:** Node.js (no framework) backend, plain ES module frontend (no build step), Postgres, `node:test` for backend integration tests.

**Spec:** none — bounded feature, approved in-chat (see conversation).

## Global Constraints

- Every new/changed backend route follows the existing `router.<verb>(path, requireAuth(...))` pattern in `backend/*/routes.js` — no new middleware abstractions.
- `frontend/js/formFields.js`'s `renderAccountFieldInput`'s per-field `<div class="${key}-container">` wrapper must NOT be touched or removed (see `CLAUDE.md` — deliberate future UI hook).
- Never trust client-side gating alone for a permission rule that has real data-integrity consequences — enforce `staffOnly` server-side in `updateCharacter`, not just by hiding the input.
- The last task in this plan runs the full `npm test` suite (not a scoped subset) and requires it green before the plan is done.
- Dispatch every task implementer WITHOUT `isolation: "worktree"` — this project's SDD process already owns one shared worktree per plan.

---

### Task 1: Remove "Wie kommst du?" self-registration mode selector

**Files:**
- Modify: `frontend/account.html:118-150` (registration form markup)
- Modify: `frontend/account.html:595-670` (registration form JS wiring)
- Modify: `frontend/account.html:850-905` (submit handler)
- Modify: `frontend/account.html:1434-1442` (dead `isModeratorOrAdmin` staff-only-option filter)
- Modify: `frontend/admin/checkin.html:431-439` (`renderConRoleCell` — widen so staff can promote ANY participant to Helfer/Hilfs-Orga/Orga, not just ones already holding one of those roles)

**Interfaces:**
- Consumes: existing `POST /events/:id/register` (already accepts `{conRole: 'sc'|'nsc', characterId, nscAvailable, nscCharacterId, otFields}` — untouched), existing `PUT /events/:id/registrations/:userId/con-role` (already accepts `{conRole: 'helfer'|'orga'|'hilfs_orga'}` for ANY current con_role — untouched, verified via `backend/registrations/repository.js`'s `resolveCharacterId`/`resolveNscAvailability`, which already null out character linkage correctly for non-sc/nsc roles).
- Produces: nothing new — this is a pure UI simplification, no backend contract changes.

No backend change: `backend/registrations/repository.js`'s `registerForEvent` already accepts `'helfer'` as a self-service `conRole` and has real, deliberate test coverage relying on that (`tests/integration/registrations.test.js` — "a participant can self-register with a self-service con_role (sc/nsc/helfer)", plus several tests using `conRole: 'helfer'` as their registration setup). Restricting that endpoint would be unrelated scope creep and would break those tests. The fix here is UI-only: the new UI simply never sends anything but `sc`/`nsc`.

- [ ] **Step 1: Remove the mode-select markup and simplify the character-select wrapper**

In `frontend/account.html`, delete lines 122-128 (the `<select id="registration-mode-select">` block and its label) entirely, so the form goes straight from the event `<select>` to `<div id="character-select-wrap">`. Leave `character-select-wrap`'s own markup (lines 130-143) unchanged.

- [ ] **Step 2: Remove the mode-select JS wiring**

In `frontend/account.html`, remove this line (around line 600):
```js
const registrationModeSelect = document.getElementById("registration-mode-select");
```

Remove the `updateRegistrationModeVisibility` function (around lines 637-639):
```js
function updateRegistrationModeVisibility() {
  characterSelectWrap.style.display = registrationModeSelect.value === "character" ? "" : "none";
}
```

Remove its call inside `populateRegistrationCharacterFields` (around line 665):
```js
  updateRegistrationModeVisibility();
```
(keep the `updateNscCharacterWrapVisibility();` call right after it)

Remove the listener registration (around line 669):
```js
registrationModeSelect.addEventListener("change", updateRegistrationModeVisibility);
```

- [ ] **Step 3: Simplify the submit handler to always take the character/NSC path**

Replace the submit handler body (around lines 850-883) from:
```js
      const eventId = eventSelect.value;
      const mode = registrationModeSelect.value;

      let conRole, characterId, nscAvailable, nscCharacterId;
      if (mode === "character") {
        const scCharacterId = characterSelect.value || undefined;
        const nscToggleOn = nscAvailableToggle.checked;
        const pickedNscCharacterId = nscToggleOn ? nscCharacterSelect.value || undefined : undefined;
        if (!scCharacterId && !nscToggleOn) {
          registrationMessage.textContent = "Wähle einen Charakter oder aktiviere die NSC-Verfügbarkeit.";
          registrationMessage.className = "error";
          return;
        }
        if (scCharacterId) {
          conRole = "sc";
          characterId = scCharacterId;
          nscAvailable = nscToggleOn;
          nscCharacterId = pickedNscCharacterId;
        } else {
          conRole = "nsc";
          characterId = pickedNscCharacterId;
          nscAvailable = false;
          nscCharacterId = undefined;
        }
      } else {
        conRole = mode;
        characterId = undefined;
        nscAvailable = false;
        nscCharacterId = undefined;
      }
```
to:
```js
      const eventId = eventSelect.value;

      const scCharacterId = characterSelect.value || undefined;
      const nscToggleOn = nscAvailableToggle.checked;
      const pickedNscCharacterId = nscToggleOn ? nscCharacterSelect.value || undefined : undefined;
      if (!scCharacterId && !nscToggleOn) {
        registrationMessage.textContent = "Wähle einen Charakter oder aktiviere die NSC-Verfügbarkeit.";
        registrationMessage.className = "error";
        return;
      }

      let conRole, characterId, nscAvailable, nscCharacterId;
      if (scCharacterId) {
        conRole = "sc";
        characterId = scCharacterId;
        nscAvailable = nscToggleOn;
        nscCharacterId = pickedNscCharacterId;
      } else {
        conRole = "nsc";
        characterId = pickedNscCharacterId;
        nscAvailable = false;
        nscCharacterId = undefined;
      }
```
(the rest of the handler — the `try { await api.post(...) }` block — is unchanged)

- [ ] **Step 4: Remove the now-dead `isModeratorOrAdmin` staff-only-option filter**

In `frontend/account.html`, remove the declaration (around line 614):
```js
    let isModeratorOrAdmin = false;
```
and remove this block (around lines 1436-1442):
```js
      isModeratorOrAdmin =
        account.group?.key === "admin" || account.group?.key === "moderator";
      if (!isModeratorOrAdmin) {
        document
          .querySelectorAll("#registration-mode-select option[data-staff-only]")
          .forEach((opt) => opt.remove());
      }
```
Confirm `isModeratorOrAdmin` has no other references left with:
```bash
grep -n isModeratorOrAdmin frontend/account.html
```
Expected: no output.

- [ ] **Step 5: Let staff promote ANY participant to Helfer/Hilfs-Orga/Orga in admin/checkin.html**

In `frontend/admin/checkin.html`, `renderConRoleCell` (around line 431-439) currently only shows the promotion `<select>` for a participant whose `conRole` is ALREADY one of `helfer`/`orga`/`hilfs_orga`. Since registration now always starts as `sc`/`nsc`, this is the only place that could ever turn someone into a Helfer/Orga afterward — widen the condition so it applies to every con_role, not just the already-staff ones:

Change:
```js
function renderConRoleCell(p) {
  const label = CON_ROLE_LABELS[p.conRole] ?? p.conRole ?? '–';
  const badge = p.nscAvailable ? ' <span class="tag">auch NSC-bereit</span>' : '';
  if (!canOverride || !p.userId || !['helfer', 'orga', 'hilfs_orga'].includes(p.conRole)) {
    return escapeHtml(label) + badge;
  }
  const options = ['helfer', 'hilfs_orga', 'orga'].map((r) => `<option value="${r}" ${r === p.conRole ? 'selected' : ''}>${CON_ROLE_LABELS[r]}</option>`).join('');
  return `<select data-con-role="${escapeHtml(p.userId)}" aria-label="Rolle ändern">${options}</select>${badge}`;
}
```
to:
```js
function renderConRoleCell(p) {
  const label = CON_ROLE_LABELS[p.conRole] ?? p.conRole ?? '–';
  const badge = p.nscAvailable ? ' <span class="tag">auch NSC-bereit</span>' : '';
  if (!canOverride || !p.userId) {
    return escapeHtml(label) + badge;
  }
  const options = ['helfer', 'hilfs_orga', 'orga'].map((r) => `<option value="${r}" ${r === p.conRole ? 'selected' : ''}>${CON_ROLE_LABELS[r]}</option>`).join('');
  return `<select data-con-role="${escapeHtml(p.userId)}" aria-label="Rolle ändern">${options}</select>${badge}`;
}
```
This reuses the existing `PUT /events/:id/registrations/:userId/con-role` route and its existing character/NSC-clearing logic unchanged — no backend change needed for this step.

- [ ] **Step 6: Manual browser verification**

Start the dev stack if not already running (`docker compose -f docker-compose.dev.yml up`, or reuse the already-running containers). In the Browser pane:
1. Log in as a plain member, go to Konto → Veranstaltung. Confirm "Wie kommst du?" is gone and the form goes straight to the character/NSC picker.
2. Register for the active event as SC. Confirm it succeeds and the resulting registration shows con_role `sc`.
3. Log in as admin, go to Check-In for that event. Confirm the new SC registrant's role cell now shows a `<select>` (Helfer/Hilfs-Orga/Orga), not plain text.
4. Pick "Helfer" from that select and confirm the promotion succeeds (reuses existing `promoteConRole` wiring) and the participant's character/NSC linkage is cleared in the row.

- [ ] **Step 7: Commit**

```bash
git add frontend/account.html frontend/admin/checkin.html
git commit -m "feat: remove self-service registration mode, let staff promote any participant to Helfer/Orga"
```

---

### Task 2: Make events deletable

**Files:**
- Modify: `backend/events/repository.js`
- Modify: `backend/events/routes.js`
- Modify: `frontend/admin/events.html`
- Test: `tests/integration/events.test.js`

**Interfaces:**
- Produces: `deleteEvent(id)` in `backend/events/repository.js` — throws an error with `.code = 'EVENT_HAS_REGISTRATIONS'` if any row in `registrations` references the event; otherwise deletes the row and returns `true`. Returns `false` if the event doesn't exist. Registers `DELETE /events/:id` (admin-only, same `requireMenu('events')` gate as the other event-management routes), returning `409` on `EVENT_HAS_REGISTRATIONS`, `404` on a missing event, `200 {deleted: true}` on success.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/events.test.js`, before the final `test.after`:
```js
test('admin can delete an event with no registrations; cannot delete one that has registrations; participant cannot delete', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const participant = await makeUserAndSession('mitglied');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Löschbares Event', eventDate: '2027-11-01' }),
    });
    const { id } = await createRes.json();

    const asParticipant = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'DELETE', headers: { Cookie: participant.cookie },
    });
    assert.equal(asParticipant.status, 403);

    const registerRes = await fetch(`http://localhost:${port}/events/${id}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(registerRes.status, 403); // event isn't active yet -- fine, we just need SOME registration row

    // Use an active event instead, so the registration above actually lands.
    await fetch(`http://localhost:${port}/events/${id}/activate`, { method: 'POST', headers: { Cookie: admin.cookie } });
    const registerActiveRes = await fetch(`http://localhost:${port}/events/${id}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(registerActiveRes.status, 201);

    const blockedDelete = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'DELETE', headers: { Cookie: admin.cookie },
    });
    assert.equal(blockedDelete.status, 409);

    await fetch(`http://localhost:${port}/events/${id}/register`, { method: 'DELETE', headers: { Cookie: participant.cookie } });

    const okDelete = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'DELETE', headers: { Cookie: admin.cookie },
    });
    assert.equal(okDelete.status, 200);
    assert.deepEqual(await okDelete.json(), { deleted: true });

    const getAfter = await fetch(`http://localhost:${port}/events/${id}`, { headers: { Cookie: admin.cookie } });
    assert.equal(getAfter.status, 404);

    const unknownDelete = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}`, {
      method: 'DELETE', headers: { Cookie: admin.cookie },
    });
    assert.equal(unknownDelete.status, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="admin can delete an event"`
Expected: FAIL (`DELETE` not implemented — 404 or 405 from the router instead of the asserted statuses).

- [ ] **Step 3: Implement `deleteEvent` in the repository**

In `backend/events/repository.js`, add after `activateEvent`:
```js
export async function deleteEvent(id) {
  const existing = await getEvent(id);
  if (!existing) return false;
  const { rows } = await query('SELECT 1 FROM registrations WHERE event_id = $1 LIMIT 1', [id]);
  if (rows.length > 0) {
    const err = new Error('Event hat noch Anmeldungen und kann nicht gelöscht werden.');
    err.code = 'EVENT_HAS_REGISTRATIONS';
    throw err;
  }
  await query('DELETE FROM events WHERE id = $1', [id]);
  return true;
}
```

- [ ] **Step 4: Register the route**

In `backend/events/routes.js`, add `deleteEvent` to the import on line 5:
```js
import { createEvent, getEvent, listEvents, updateEvent, activateEvent, deleteEvent } from './repository.js';
```
Add after the `POST /events/:id/activate` route:
```js
router.delete('/events/:id', requireAuth(requireMenu('events')(async ({ params }) => {
  try {
    const deleted = await deleteEvent(params.id);
    if (!deleted) return { status: 404, body: { error: 'event not found' } };
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'EVENT_HAS_REGISTRATIONS') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="admin can delete an event"`
Expected: PASS

- [ ] **Step 6: Add the delete button to the admin UI**

In `frontend/admin/events.html`, add a 6th column. Change the header (line 32):
```html
<thead><tr><th>Name</th><th>Datum</th><th>Status</th><th></th><th></th></tr></thead>
```
to:
```html
<thead><tr><th>Name</th><th>Datum</th><th>Status</th><th></th><th></th><th></th></tr></thead>
```

Change the row template inside `loadEvents` (lines 75-81) from:
```js
  listBody.innerHTML = events.map((e) => `<tr>
    <td>${escapeHtml(e.name)}</td>
    <td>${escapeHtml(e.event_date)}</td>
    <td>${e.is_active ? '<span class="badge badge-active">Aktiv – Anmeldung offen</span>' : '<span class="badge badge-inactive">Inaktiv</span>'}</td>
    <td>${e.is_active ? '' : `<button type="button" class="btn-sm" data-activate="${e.id}">Aktivieren</button>`}</td>
    <td><button type="button" class="btn-sm btn-ghost" data-edit="${e.id}">Bearbeiten</button></td>
  </tr>`).join('');
```
to:
```js
  listBody.innerHTML = events.map((e) => `<tr>
    <td>${escapeHtml(e.name)}</td>
    <td>${escapeHtml(e.event_date)}</td>
    <td>${e.is_active ? '<span class="badge badge-active">Aktiv – Anmeldung offen</span>' : '<span class="badge badge-inactive">Inaktiv</span>'}</td>
    <td>${e.is_active ? '' : `<button type="button" class="btn-sm" data-activate="${e.id}">Aktivieren</button>`}</td>
    <td><button type="button" class="btn-sm btn-ghost" data-edit="${e.id}">Bearbeiten</button></td>
    <td><button type="button" class="btn-sm btn-ghost" data-delete="${e.id}">Löschen</button></td>
  </tr>`).join('');
```

Add a click handler for the new buttons right after the existing `[data-activate]` handler block (after line 104's closing `});`):
```js
  listBody.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const eventData = events.find((e) => e.id === button.dataset.delete);
      if (!confirm(`"${eventData.name}" wirklich löschen? Das kann nicht rückgängig gemacht werden.`)) return;
      message.textContent = '';
      message.className = '';
      try {
        await api.delete(`/events/${button.dataset.delete}`);
        message.textContent = 'Gelöscht.';
        message.className = 'success';
        await loadEvents();
      } catch (err) {
        message.textContent = err.status === 409 ? err.body.error : err.message;
        message.className = 'error';
      }
    });
  });
```

- [ ] **Step 7: Manual browser verification**

In the Browser pane, log in as admin, go to Events verwalten. Create a throwaway test event with no registrations, click "Löschen", confirm the dialog, confirm it disappears from the list. Attempt to delete an event that has real registrations (e.g. the active con) and confirm it shows the 409 error message instead of deleting.

- [ ] **Step 8: Commit**

```bash
git add backend/events/repository.js backend/events/routes.js frontend/admin/events.html tests/integration/events.test.js
git commit -m "feat: allow admins to delete events with no registrations"
```

---

### Task 3: Restrict the check-in event dropdown to the active event

**Files:**
- Modify: `frontend/admin/checkin.html:622-623`

**Interfaces:**
- Consumes: existing `GET /events` (unchanged) — filtering happens client-side, matching this page's existing pattern of light client-side derivation from the same `/events` payload used elsewhere.

- [ ] **Step 1: Filter the event list to active events only**

In `frontend/admin/checkin.html`, change:
```js
  events = await api.get('/events');
  eventSelect.innerHTML = renderEventOptions(events);
```
to:
```js
  events = (await api.get('/events')).filter((e) => e.is_active);
  eventSelect.innerHTML = renderEventOptions(events);
```

- [ ] **Step 2: Manual browser verification**

In the Browser pane, log in as admin, go to Check-In. Confirm the event dropdown shows only the currently-active event (compare against Events verwalten's list, which still shows all events). Deactivate-then-reactivate a different event via Events verwalten if there's more than one event in the dev DB, and confirm the Check-In dropdown follows.

- [ ] **Step 3: Commit**

```bash
git add frontend/admin/checkin.html
git commit -m "fix: only show the active event in the check-in dropdown"
```

---

### Task 4: Harden the scan dialog's Enter-key focus handling

**Files:**
- Modify: `frontend/admin/checkin.html:265-287` (`openScanDialog`)

**Interfaces:** none — self-contained frontend change.

Live investigation during planning: reproducing the scan dialog's `Enter` handling directly in the browser (forcing a real `KeyboardEvent{key:'Enter'}` while the dialog is open) showed the existing `document.addEventListener('keydown', ...)` handler in `checkin.html` DOES correctly trigger check-in — this logic is not provably broken by static reading or direct reproduction. The most plausible remaining explanation is a cross-browser inconsistency in which element `showModal()` autofocuses (the HTML spec says the first focusable descendant, which most browsers give as the `scan-confirm` button, but this hasn't been true across every WebKit/tablet version historically). This step makes focus deterministic instead of relying on browser default behavior. **This is a best-effort mitigation, not a proven root-cause fix** — flag to the user to re-test on the real check-in device after this ships, since it's possible the real cause is something this session's headless browser tooling can't observe (touch-device quirk, a different browser engine, etc.).

- [ ] **Step 1: Explicitly focus the confirm button after opening the dialog**

In `frontend/admin/checkin.html`, `openScanDialog` currently ends with:
```js
  confirmButton.dataset.userId = lookup.userId;
  scanDialog.showModal();
  scanDialogAutoCloseId = setTimeout(() => { if (scanDialog.open) scanDialog.close(); }, 30000);
}
```
Change to:
```js
  confirmButton.dataset.userId = lookup.userId;
  scanDialog.showModal();
  // Cross-browser hardening: don't rely on showModal()'s own default-focus
  // behavior (inconsistent across browsers/tablets) to put focus on the
  // confirm button -- do it explicitly so the Enter hotkey has a
  // deterministic, real DOM focus target to activate.
  if (!confirmButton.disabled) confirmButton.focus();
  scanDialogAutoCloseId = setTimeout(() => { if (scanDialog.open) scanDialog.close(); }, 30000);
}
```

- [ ] **Step 2: Manual browser verification**

In the Browser pane: open Check-In, manually open the scan dialog (or use `javascript_tool` to call the same DOM state the earlier investigation used), confirm `document.activeElement` is the `scan-confirm` button, and confirm pressing Enter (a real, well-formed `KeyboardEvent`) still checks the participant in and closes the dialog. Note in the task's completion report that this is a hardening fix pending the user's confirmation on their real check-in device.

- [ ] **Step 3: Commit**

```bash
git add frontend/admin/checkin.html
git commit -m "fix: explicitly focus the scan dialog's confirm button (Enter-key hardening)"
```

---

### Task 5: Add up/down field reordering to the character-schema editor

**Files:**
- Modify: `frontend/admin/character-schema.html`

**Interfaces:** none — schema order is already just array order (the backend has no ordering concept to change; `collectSchema` already reads rows in DOM order and saves the resulting array as-is).

- [ ] **Step 1: Add ▲/▼ buttons to each schema row**

In `frontend/admin/character-schema.html`, `addSchemaRow` currently ends its `row.innerHTML` with the "Entfernen" button:
```js
    <label><input type="checkbox" class="schema-required" ${field.required ? 'checked' : ''}> Pflichtfeld</label>
    ${publicCheckboxHtml}
    <button type="button" class="remove-row">Entfernen</button>
  `;
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  container.appendChild(row);
}
```
Change to add move buttons before "Entfernen":
```js
    <label><input type="checkbox" class="schema-required" ${field.required ? 'checked' : ''}> Pflichtfeld</label>
    ${publicCheckboxHtml}
    <button type="button" class="move-up" aria-label="Nach oben verschieben">▲</button>
    <button type="button" class="move-down" aria-label="Nach unten verschieben">▼</button>
    <button type="button" class="remove-row">Entfernen</button>
  `;
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  row.querySelector('.move-up').addEventListener('click', () => {
    const prev = row.previousElementSibling;
    if (prev) row.parentElement.insertBefore(row, prev);
  });
  row.querySelector('.move-down').addEventListener('click', () => {
    const next = row.nextElementSibling;
    if (next) row.parentElement.insertBefore(next, row);
  });
  container.appendChild(row);
}
```

- [ ] **Step 2: Manual browser verification**

In the Browser pane, log in as admin, go to Charakterschema, SC/GSC tab. Confirm each row now has ▲/▼ buttons, clicking them reorders the rows visually, clicking "Speichern" persists the new order, and reloading the page shows fields in the new order (confirms `collectSchema`'s DOM-order read + the schema GET round-trip both preserve it). Repeat once for the NSC tab (also `allowPublic: true`, same code path) — the Konto/Anmeldung tabs use the identical `addSchemaRow` function so don't need a separate check.

- [ ] **Step 3: Commit**

```bash
git add frontend/admin/character-schema.html
git commit -m "feat: add up/down reordering to the character-schema field editor"
```

---

### Task 6: Per-field "staff only" edit lock for character schema fields

**Files:**
- Modify: `frontend/js/formFields.js` (`renderField`)
- Modify: `frontend/admin/character-schema.html` (schema row editor — reuse the existing `allowPublic`-gated checkbox group)
- Modify: `backend/characters/repository.js` (`updateCharacter`)
- Modify: `backend/characters/routes.js` (pass elevation flag through)
- Modify: `frontend/account.html` (owner's own SC/NSC character form — render `staffOnly` fields read-only)
- Test: `tests/integration/characters.test.js`

**Interfaces:**
- Consumes: `user.group.canOverrideCheckinStatus` (already computed in `backend/characters/routes.js` as `isElevated` for the existing owner-or-elevated PUT gate).
- Produces: `renderField(field, value, idPrefix = '', { readOnly = false } = {})` — 4th parameter, adds a `disabled` attribute to the rendered control when `readOnly` is true. `updateCharacter(id, userId, { name, data, isGsc }, { isElevated = false } = {})` — new 4th parameter; when `data !== undefined` and `!isElevated`, every schema field flagged `staffOnly: true` has its value forced back to the character's EXISTING stored value before validation, regardless of what the caller sent (closes the same class of "disabled input silently wipes a value" bug this project has hit before — a disabled input's value never reaches the owner's own submitted payload, so the server must be the one preserving it, not the client).

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/characters.test.js`. This file already has `makeUserAndSession(groupKey = 'mitglied')`, `setScSchema(schema)`, and a `test.beforeEach` that resets the SC schema to a single `fraction` field before every test — call `setScSchema` again inside this test to override that default, same as any other test in this file that needs a custom schema:
```js
test('a staffOnly character field cannot be changed by the owner, but can be changed by canOverrideCheckinStatus staff', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    await setScSchema([
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'itGeld', label: 'IT-Geld', type: 'number', staffOnly: true },
    ]);

    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ class: 'sc', name: 'Aldric', data: { name: 'Aldric', itGeld: 100 } }),
    });
    const character = await createRes.json();
    assert.equal(character.data.itGeld, 100);

    // Owner tries to change itGeld -- must be silently ignored, not an error,
    // since the owner's own edit form doesn't even render an input for it.
    const ownerUpdate = await fetch(`http://localhost:${port}/characters/${character.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ data: { name: 'Aldric', itGeld: 9999 } }),
    });
    assert.equal(ownerUpdate.status, 200);
    assert.equal((await ownerUpdate.json()).data.itGeld, 100);

    const admin = await makeUserAndSession('admin');
    const staffUpdate = await fetch(`http://localhost:${port}/characters/${character.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ data: { name: 'Aldric', itGeld: 50 } }),
    });
    assert.equal(staffUpdate.status, 200);
    assert.equal((await staffUpdate.json()).data.itGeld, 50);
  });
});
```
Check the top of `tests/integration/characters.test.js` first for the exact helper names/signatures already in that file (e.g. `makeUserAndSession`, how a schema is set up for a test, how `admin` sessions are created) and adjust the snippet above to match — this file already has its own established helpers, reuse them rather than duplicating `events.test.js`'s.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="staffOnly character field"`
Expected: FAIL (owner's update currently succeeds in overwriting `itGeld` to 9999).

- [ ] **Step 3: Enforce `staffOnly` server-side in `updateCharacter`**

In `backend/characters/repository.js`, change:
```js
export async function updateCharacter(id, userId, { name, data, isGsc }) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  let newData;
  if (data !== undefined) {
    const schema = await schemaForClass(character.class);
    const errors = validateCharacterData(schema, data);
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
    newData = data;
  }
```
to:
```js
export async function updateCharacter(id, userId, { name, data, isGsc }, { isElevated = false } = {}) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  let newData;
  if (data !== undefined) {
    const schema = await schemaForClass(character.class);
    // A staffOnly field's value can never be changed by the owner
    // themselves -- their own edit form doesn't even render an input for
    // it (a disabled input never reaches FormData), so trust the SERVER's
    // existing value here rather than whatever the client happened to
    // send, regardless of type or emptiness.
    const effectiveData = isElevated ? data : { ...data };
    if (!isElevated) {
      for (const field of schema) {
        if (field.staffOnly) effectiveData[field.key] = character.data?.[field.key];
      }
    }
    const errors = validateCharacterData(schema, effectiveData);
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
    newData = effectiveData;
  }
```

- [ ] **Step 4: Pass the elevation flag from the route**

In `backend/characters/routes.js`, change:
```js
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
```
to:
```js
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
    const updated = await updateCharacter(params.id, character.user_id, body, { isElevated });
    return { status: 200, body: updated };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="staffOnly character field"`
Expected: PASS

- [ ] **Step 6: Add a `readOnly` option to `renderField`**

In `frontend/js/formFields.js`, change the signature and every branch of `renderField`:
```js
export function renderField(field, value, idPrefix = '') {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key) + (field.required ? ' *' : '');
  const key = escapeHtml(field.key);
  const required = field.required ? 'required' : '';
  const id = `${idPrefix}field-${key}`;

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
  if (field.type === 'link') {
    return `<input id="${id}" name="${key}" type="url" value="${val}" ${required}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'date') {
    return `<input id="${id}" name="${key}" type="date" value="${val}" ${required}><label for="${id}">${label}</label>`;
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
to:
```js
export function renderField(field, value, idPrefix = '', { readOnly = false } = {}) {
  const val = escapeHtml(value);
  const label = escapeHtml(field.label ?? field.key) + (field.required ? ' *' : '') + (readOnly ? ' 🔒' : '');
  const key = escapeHtml(field.key);
  const required = field.required ? 'required' : '';
  const disabled = readOnly ? 'disabled' : '';
  const id = `${idPrefix}field-${key}`;

  if (field.type === 'boolean') {
    const checked = value ? ' checked' : '';
    return `<label for="${id}"><input id="${id}" name="${key}" type="checkbox"${checked} ${disabled}> ${label}</label>`;
  }
  if (field.type === 'multiselect' && Array.isArray(field.options)) {
    const selected = Array.isArray(value) ? value : [];
    const checkboxes = field.options.map((opt, i) => {
      const escapedOpt = escapeHtml(opt);
      const checked = selected.includes(opt) ? ' checked' : '';
      return `<label for="${id}-${i}"><input id="${id}-${i}" name="${key}" type="checkbox" value="${escapedOpt}"${checked} ${disabled}> ${escapedOpt}</label>`;
    }).join('');
    return `<span>${label}</span>${checkboxes}`;
  }
  if (field.type === 'number') {
    return `<input id="${id}" name="${key}" type="number" value="${val}" ${required} ${disabled}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'link') {
    return `<input id="${id}" name="${key}" type="url" value="${val}" ${required} ${disabled}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'date') {
    return `<input id="${id}" name="${key}" type="date" value="${val}" ${required} ${disabled}><label for="${id}">${label}</label>`;
  }
  if (field.type === 'textarea') {
    return `<textarea id="${id}" name="${key}" ${required} ${disabled}>${val}</textarea><label for="${id}">${label}</label>`;
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    const blankOption = field.required ? '' : '<option value=""></option>';
    const options = field.options.map((opt) => {
      const escapedOpt = escapeHtml(opt);
      const selected = opt === value ? ' selected' : '';
      return `<option value="${escapedOpt}"${selected}>${escapedOpt}</option>`;
    }).join('');
    return `<select id="${id}" name="${key}" ${required} ${disabled}>${blankOption}${options}</select><label for="${id}">${label}</label>`;
  }
  return `<input id="${id}" name="${key}" type="text" value="${val}" ${required} ${disabled}><label for="${id}">${label}</label>`;
}
```
`admin/checkin.html`'s existing call site (`renderField(field, c.data?.[field.key], \`char-${c.id}-\`)`) is unaffected — it doesn't pass a 4th argument, so `readOnly` defaults to `false` there, keeping the staff edit dialog fully editable as today.

- [ ] **Step 7: Render `staffOnly` fields read-only on the owner's own character form**

In `frontend/account.html`, change the SC character field rendering (around line 920):
```js
        .map((field) => renderField(field, data[field.key], "sc-char-"))
```
to:
```js
        .map((field) => renderField(field, data[field.key], "sc-char-", { readOnly: field.staffOnly === true }))
```
and the two NSC field rendering call sites (around lines 1123 and 1127):
```js
          .map((field) => `<div class="form-group multiselect">${renderField(field, data[field.key], "nsc-")}</div>`)
```
```js
          .map((field) => `<div class="form-group">${renderField(field, data[field.key], "nsc-")}</div>`)
```
to:
```js
          .map((field) => `<div class="form-group multiselect">${renderField(field, data[field.key], "nsc-", { readOnly: field.staffOnly === true })}</div>`)
```
```js
          .map((field) => `<div class="form-group">${renderField(field, data[field.key], "nsc-", { readOnly: field.staffOnly === true })}</div>`)
```

- [ ] **Step 8: Add the "Nur Staff darf bearbeiten" checkbox to the schema editor**

In `frontend/admin/character-schema.html`, `addSchemaRow` already threads an `allowPublic` option that's `true` for the SC/GSC and NSC tabs and `false` for Konto/Anmeldung — `staffOnly` is IT-only (character fields) exactly like `public`, so reuse the same flag rather than adding a new one. Change:
```js
function addSchemaRow(container, field = { key: '', label: '', type: 'text', required: false, public: false, options: [] }, { allowPublic = true } = {}) {
  const row = document.createElement('div');
  row.className = 'schema-row';
  const optionsValue = Array.isArray(field.options) ? field.options.join(', ') : '';
  const publicCheckboxHtml = allowPublic
    ? `<label><input type="checkbox" class="schema-public" ${field.public ? 'checked' : ''}> Öffentlich sichtbar</label>`
    : '';
  row.innerHTML = `
```
to:
```js
function addSchemaRow(container, field = { key: '', label: '', type: 'text', required: false, public: false, staffOnly: false, options: [] }, { allowPublic = true } = {}) {
  const row = document.createElement('div');
  row.className = 'schema-row';
  const optionsValue = Array.isArray(field.options) ? field.options.join(', ') : '';
  const publicCheckboxHtml = allowPublic
    ? `<label><input type="checkbox" class="schema-public" ${field.public ? 'checked' : ''}> Öffentlich sichtbar</label>
       <label><input type="checkbox" class="schema-staff-only" ${field.staffOnly ? 'checked' : ''}> Nur Staff darf bearbeiten</label>`
    : '';
  row.innerHTML = `
```
and change `collectSchema`:
```js
function collectSchema(container, { allowPublic = true } = {}) {
  return [...container.children].map((row) => {
    const type = row.querySelector('.schema-type').value;
    const field = {
      key: row.querySelector('.schema-key').value.trim(),
      label: row.querySelector('.schema-label').value.trim(),
      type,
      required: row.querySelector('.schema-required').checked,
    };
    if (allowPublic) field.public = row.querySelector('.schema-public').checked;
```
to:
```js
function collectSchema(container, { allowPublic = true } = {}) {
  return [...container.children].map((row) => {
    const type = row.querySelector('.schema-type').value;
    const field = {
      key: row.querySelector('.schema-key').value.trim(),
      label: row.querySelector('.schema-label').value.trim(),
      type,
      required: row.querySelector('.schema-required').checked,
    };
    if (allowPublic) {
      field.public = row.querySelector('.schema-public').checked;
      field.staffOnly = row.querySelector('.schema-staff-only').checked;
    }
```

- [ ] **Step 9: Manual browser verification**

In the Browser pane: as admin, go to Charakterschema, add a field with "Nur Staff darf bearbeiten" checked to the SC/GSC schema, save. Go to Konto → Charaktere as a plain member with an existing SC character, confirm that field renders disabled (with the 🔒 marker) and the form still saves successfully without wiping other fields. Then, as admin (or moderator), open that same character via admin/checkin.html's ad-hoc edit dialog and confirm the field is fully editable there, and that a change to it actually persists.

- [ ] **Step 10: Commit**

```bash
git add frontend/js/formFields.js frontend/admin/character-schema.html backend/characters/repository.js backend/characters/routes.js frontend/account.html tests/integration/characters.test.js
git commit -m "feat: add a per-field staff-only edit lock to character schemas"
```

---

### Task 7: Admin on/off switch for "Charaktere durchsuchen"

**Files:**
- Create: `db/migrations/037_character_browsing_toggle.sql`
- Modify: `backend/appSettings/repository.js`
- Modify: `backend/appSettings/routes.js`
- Modify: `backend/characters/routes.js` (`GET /events/:eventId/characters/public`)
- Modify: `frontend/admin/settings.html`
- Modify: `frontend/account.html` (hide the browse link when disabled)
- Modify: `tests/integration/appSettings.test.js` (existing default-settings test + a new PUT round-trip assertion)
- Modify: `tests/integration/charactersVisibility.test.js` (new gating test)

**Interfaces:**
- Produces: `getAppSettings()` now also returns `characterBrowsingEnabled: boolean` (default `true`). `setAppSettings({..., characterBrowsingEnabled})` accepts an optional boolean. `GET /events/:eventId/characters/public` returns `403 {error: 'character browsing is disabled'}` when the setting is off.

- [ ] **Step 1: Update the existing default-settings test (it will otherwise break)**

`tests/integration/appSettings.test.js` has an existing test, `'GET /app-settings requires no authentication and returns nulls when unset'`, that does a strict `assert.deepEqual` against the full settings object. Adding a new field breaks it unless updated. Change:
```js
    assert.deepEqual(body, { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, hasUploadedLogo: false, hasUploadedTicketBackground: false });
```
to:
```js
    assert.deepEqual(body, { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, characterBrowsingEnabled: true, hasUploadedLogo: false, hasUploadedTicketBackground: false });
```

- [ ] **Step 2: Write the failing tests**

In `tests/integration/appSettings.test.js`, add (this file's `makeUserAndSession(groupKey)` returns a cookie STRING, not an object — match that shape):
```js
test('PUT /app-settings can change characterBrowsingEnabled independently of other fields', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const disableRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ characterBrowsingEnabled: false }),
    });
    assert.equal(disableRes.status, 200);
    const disabled = await disableRes.json();
    assert.equal(disabled.characterBrowsingEnabled, false);

    // Re-enable so this doesn't leak disabled state into later tests/files
    // sharing the same single-row app_settings table.
    const reenableRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ characterBrowsingEnabled: true }),
    });
    assert.equal((await reenableRes.json()).characterBrowsingEnabled, true);
  });
});
```

In `tests/integration/charactersVisibility.test.js`, add (this file already has `makeUserAndSession`, `setScSchema`, `makeEvent`, `makeRegisteredCharacter` — reuse them):
```js
test('disabling characterBrowsingEnabled blocks GET /events/:id/characters/public with 403', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const viewer = await makeUserAndSession();
    await setScSchema(VISIBILITY_SCHEMA);
    const eventId = await makeEvent();
    const owner = await makeUserAndSession();
    await makeRegisteredCharacter(port, owner.cookie, eventId, 'Aldric', { fraction: 'Rebellen' });

    const openRes = await fetch(`http://localhost:${port}/events/${eventId}/characters/public`, {
      headers: { Cookie: viewer.cookie },
    });
    assert.equal(openRes.status, 200);

    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ characterBrowsingEnabled: false }),
    });

    const blockedRes = await fetch(`http://localhost:${port}/events/${eventId}/characters/public`, {
      headers: { Cookie: viewer.cookie },
    });
    assert.equal(blockedRes.status, 403);

    // Re-enable so this doesn't leak disabled state into later tests.
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ characterBrowsingEnabled: true }),
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="characterBrowsingEnabled|characters/public with 403"`
Expected: FAIL (column doesn't exist yet / field always undefined / route never 403s).

- [ ] **Step 4: Add the migration**

Create `db/migrations/037_character_browsing_toggle.sql`:
```sql
ALTER TABLE app_settings ADD COLUMN character_browsing_enabled boolean not null default true;
```

- [ ] **Step 5: Wire it through the repository**

In `backend/appSettings/repository.js`, change:
```js
export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name, quota_mb_per_character, invitation_ttl_days, logo_data IS NOT NULL AS has_uploaded_logo, ticket_bg_data IS NOT NULL AS has_uploaded_ticket_background FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, hasUploadedLogo: false, hasUploadedTicketBackground: false };
  return {
    logoUrl: rows[0].logo_url,
    appTitle: rows[0].app_title,
    eventName: rows[0].event_name,
    quotaMbPerCharacter: rows[0].quota_mb_per_character,
    invitationTtlDays: rows[0].invitation_ttl_days,
    hasUploadedLogo: rows[0].has_uploaded_logo,
    hasUploadedTicketBackground: rows[0].has_uploaded_ticket_background,
  };
}

export async function setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays }) {
  const id = await ensureSettingsRow();
  await query(
    'UPDATE app_settings SET logo_url = COALESCE($2, logo_url), app_title = COALESCE($3, app_title), event_name = COALESCE($4, event_name), quota_mb_per_character = COALESCE($5, quota_mb_per_character), invitation_ttl_days = COALESCE($6, invitation_ttl_days) WHERE id = $1',
    [id, logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null, invitationTtlDays ?? null]
  );
  return getAppSettings();
}
```
to:
```js
export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name, quota_mb_per_character, invitation_ttl_days, character_browsing_enabled, logo_data IS NOT NULL AS has_uploaded_logo, ticket_bg_data IS NOT NULL AS has_uploaded_ticket_background FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, invitationTtlDays: 3, characterBrowsingEnabled: true, hasUploadedLogo: false, hasUploadedTicketBackground: false };
  return {
    logoUrl: rows[0].logo_url,
    appTitle: rows[0].app_title,
    eventName: rows[0].event_name,
    quotaMbPerCharacter: rows[0].quota_mb_per_character,
    invitationTtlDays: rows[0].invitation_ttl_days,
    characterBrowsingEnabled: rows[0].character_browsing_enabled,
    hasUploadedLogo: rows[0].has_uploaded_logo,
    hasUploadedTicketBackground: rows[0].has_uploaded_ticket_background,
  };
}

export async function setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled }) {
  const id = await ensureSettingsRow();
  await query(
    'UPDATE app_settings SET logo_url = COALESCE($2, logo_url), app_title = COALESCE($3, app_title), event_name = COALESCE($4, event_name), quota_mb_per_character = COALESCE($5, quota_mb_per_character), invitation_ttl_days = COALESCE($6, invitation_ttl_days), character_browsing_enabled = COALESCE($7, character_browsing_enabled) WHERE id = $1',
    [id, logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null, invitationTtlDays ?? null, characterBrowsingEnabled ?? null]
  );
  return getAppSettings();
}
```
(this preserves the existing COALESCE-everything discipline this table already established — see the project history note about every column needing COALESCE from day one)

- [ ] **Step 6: Accept the field in the PUT route**

In `backend/appSettings/routes.js`, change:
```js
router.put('/app-settings', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays } = body;
  if (quotaMbPerCharacter !== undefined && (!Number.isInteger(quotaMbPerCharacter) || quotaMbPerCharacter < 1)) {
    return { status: 400, body: { error: 'quotaMbPerCharacter must be a positive integer' } };
  }
  if (invitationTtlDays !== undefined && (!Number.isInteger(invitationTtlDays) || invitationTtlDays < 1)) {
    return { status: 400, body: { error: 'invitationTtlDays must be a positive integer' } };
  }
  const saved = await setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays });
  return { status: 200, body: saved };
})));
```
to:
```js
router.put('/app-settings', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled } = body;
  if (quotaMbPerCharacter !== undefined && (!Number.isInteger(quotaMbPerCharacter) || quotaMbPerCharacter < 1)) {
    return { status: 400, body: { error: 'quotaMbPerCharacter must be a positive integer' } };
  }
  if (invitationTtlDays !== undefined && (!Number.isInteger(invitationTtlDays) || invitationTtlDays < 1)) {
    return { status: 400, body: { error: 'invitationTtlDays must be a positive integer' } };
  }
  if (characterBrowsingEnabled !== undefined && typeof characterBrowsingEnabled !== 'boolean') {
    return { status: 400, body: { error: 'characterBrowsingEnabled must be a boolean' } };
  }
  const saved = await setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter, invitationTtlDays, characterBrowsingEnabled });
  return { status: 200, body: saved };
})));
```

- [ ] **Step 7: Gate the public browse endpoint**

In `backend/characters/routes.js`, add the import:
```js
import { getAppSettings } from '../appSettings/repository.js';
```
Change:
```js
router.get('/events/:eventId/characters/public', requireAuth(async ({ params, user }) => {
  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const schema = await getScCharacterSchema();
```
to:
```js
router.get('/events/:eventId/characters/public', requireAuth(async ({ params, user }) => {
  const { characterBrowsingEnabled } = await getAppSettings();
  if (!characterBrowsingEnabled) return { status: 403, body: { error: 'character browsing is disabled' } };
  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  const schema = await getScCharacterSchema();
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="characterBrowsingEnabled|characters/public with 403"`
Expected: PASS

- [ ] **Step 9: Add the admin toggle to admin/settings.html**

In `frontend/admin/settings.html`, add a new card after the "Einladungen" card (before `<p id="message"></p>`):
```html
    <div class="card form-pad">
      <h2>Charaktere durchsuchen</h2>
      <p class="sub">Schaltet die öffentliche "Charaktere anderer Spieler durchsuchen"-Seite für alle Nutzer ein oder aus.</p>
      <label><input type="checkbox" id="character-browsing-toggle"> Charaktere durchsuchen aktiviert</label>
    </div>
```
In the `<script type="module">` block, add after `loadInvitationSettings`'s definition:
```js
async function loadCharacterBrowsingSetting() {
  const settings = await api.get('/app-settings');
  document.getElementById('character-browsing-toggle').checked = settings.characterBrowsingEnabled;
}

document.getElementById('character-browsing-toggle').addEventListener('change', async (event) => {
  message.textContent = '';
  message.className = '';
  try {
    await api.put('/app-settings', { characterBrowsingEnabled: event.target.checked });
    message.textContent = 'Gespeichert.';
    message.className = 'success';
  } catch (err) {
    event.target.checked = !event.target.checked;
    message.textContent = err.message;
    message.className = 'error';
  }
});
```
Add a call to `loadCharacterBrowsingSetting()` alongside the existing `await loadSettings(); await loadInvitationSettings();` in the page's final init `try` block.

- [ ] **Step 10: Hide the browse link on account.html when disabled**

In `frontend/account.html`, give the existing link an id. Change:
```html
            <p><a href="/characters-browse.html">Charaktere anderer Spieler durchsuchen</a></p>
```
to:
```html
            <p id="browse-characters-link"><a href="/characters-browse.html">Charaktere anderer Spieler durchsuchen</a></p>
```
In the main init `try` block (the same one that calls `renderNavLinks`/loads `account-schema` etc.), add:
```js
      const { characterBrowsingEnabled } = await api.get("/app-settings");
      document.getElementById("browse-characters-link").style.display = characterBrowsingEnabled ? "" : "none";
```
Place this call alongside the other one-off settings-driven UI toggles already in that same `try` block (fail-quiet is fine here — if `/app-settings` errors, this block just won't run and the link stays visible, matching this project's existing "branding-style fail-quiet" convention for this kind of cosmetic settings fetch).

- [ ] **Step 11: Manual browser verification**

In the Browser pane: as admin, go to Einstellungen, confirm the new "Charaktere durchsuchen aktiviert" checkbox defaults to checked. Uncheck it, confirm it saves. Go to Konto → Charaktere as a plain member and confirm the "Charaktere anderer Spieler durchsuchen" link is gone. Try navigating to `/characters-browse.html` directly and confirm the page's own API calls now fail with 403 (open the page, check the Network tab / `read_network_requests` for a 403 on the public-characters endpoint). Re-enable the toggle and confirm the link reappears.

- [ ] **Step 12: Commit**

```bash
git add db/migrations/037_character_browsing_toggle.sql backend/appSettings/repository.js backend/appSettings/routes.js backend/characters/routes.js frontend/admin/settings.html frontend/account.html tests/integration/appSettings.test.js tests/integration/charactersVisibility.test.js
git commit -m "feat: add an admin on/off switch for the character-browsing page"
```

---

### Task 8: Full test suite gate

**Files:** none — verification only.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test passes, including all new tests added in Tasks 2, 6, and 7. This is a full run, not a scoped `--test-name-pattern`, per this project's standing process rule that every plan's last task must run the complete suite at least once.

- [ ] **Step 2: If anything fails, fix forward**

Diagnose and fix any failure directly (most likely candidates: a stale migration number collision with another concurrent worktree/branch touching `db/migrations/037_*.sql` — check `git log --oneline -5 -- db/migrations` on master before merging; or a test-file helper name mismatch from Tasks 6/7's "check the file's existing helpers first" steps). Re-run `npm test` until green.

- [ ] **Step 3: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix: address full-suite failures found in final verification"
```
(skip this step entirely if Step 1 was already green on the first run)
