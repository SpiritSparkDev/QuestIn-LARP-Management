# Hotkey-Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user configure their own keyboard shortcuts for the check-in page's QR-scan popup (confirm / cancel / start scan), stored per-account, with sensible defaults (Enter/Escape/Space).

**Architecture:** A new `users.hotkeys jsonb` column, self-service (ungated) via the existing `PATCH /account`. A small config UI and a document-level `keydown` listener on `admin/checkin.html`, wired to the exact same handler functions the existing "Einchecken"/"Abbrechen"/"Scan starten" buttons already call — hotkeys are an alternate trigger for existing actions, not new logic.

**Tech Stack:** Node.js stdlib backend, vanilla JS frontend, Postgres, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-qrcode-qol-design.md` (Plan 4)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step.
- Never call `applyBranding()` (already present on `admin/checkin.html`) with a blocking top-level `await` — this bug class has been found and fixed three times already in this initiative. This plan adds no new top-level awaits; confirm this remains true after your changes.
- Hotkeys must be genuinely OPTIONAL self-service data (matching `firstName`/`lastName`'s existing ungated pattern on `PATCH /account`) — no group permission gates this field, since every user configures their own hotkeys for their own use of the check-in page (only `checkin`-menu groups can reach that page at all, which is already enforced elsewhere and unrelated to this field).
- Hotkeys must never fire while the user is typing in an unrelated input (the event-select dropdown, the participant search box) — only when the scan dialog is open, or when no input/select/textarea currently has focus.

---

### Task 1: Backend — `users.hotkeys`, self-service via `PATCH /account`

**Files:**
- Create: `db/migrations/021_users_hotkeys.sql`
- Modify: `backend/accounts/repository.js`
- Modify: `tests/integration/accounts.test.js`

**Interfaces:**
- Produces: `GET /account` now includes `hotkeys: object` in its response (defaults to `{}` for a user who never configured any). `PATCH /account` accepts an optional `hotkeys` field (any JSON object; stored as-is, no server-side shape validation — this mirrors this project's existing treatment of other free-form per-user JSON preferences and keeps this a low-stakes, purely cosmetic field).

- [ ] **Step 1: Write the migration**

Create `db/migrations/021_users_hotkeys.sql`:

```sql
ALTER TABLE users ADD COLUMN hotkeys jsonb NOT NULL DEFAULT '{}';
```

- [ ] **Step 2: Wire it into the repository**

Read the current file first (76 lines: `decryptAccount`, `SELECT_COLUMNS`, `FROM_JOIN`, `getAccount`, `updateAccount`). Make these exact changes:

In `decryptAccount`, add one line (place it near the end, alongside the other non-encrypted passthrough fields like `nickname`):

```javascript
    hotkeys: row.hotkeys,
```

In `SELECT_COLUMNS`, add `users.hotkeys` to the first line's column list:

```javascript
const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.hotkeys,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields, groups.character_classes, groups.can_override_checkin_status
`;
```

In `updateAccount`, add `hotkeys` to the SQL, matching `nickname`'s exact ungated `COALESCE` treatment (not the `!== undefined` treatment the encrypted fields use, since `hotkeys` needs no encryption step — it's a direct value, closer in shape to `nickname` than to `address`):

```javascript
export async function updateAccount(userId, fields) {
  const { rows } = await query(
    `UPDATE users SET
       first_name = COALESCE($2, first_name),
       last_name = COALESCE($3, last_name),
       nickname = COALESCE($4, nickname),
       hotkeys = COALESCE($5, hotkeys),
       address_enc = COALESCE($6, address_enc),
       birthdate_enc = COALESCE($7, birthdate_enc),
       phone_enc = COALESCE($8, phone_enc),
       emergency_contact_last_name_enc = COALESCE($9, emergency_contact_last_name_enc),
       emergency_contact_first_name_enc = COALESCE($10, emergency_contact_first_name_enc),
       emergency_contact_phone_enc = COALESCE($11, emergency_contact_phone_enc),
       medical_notes_enc = COALESCE($12, medical_notes_enc)
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      fields.hotkeys !== undefined ? JSON.stringify(fields.hotkeys) : null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContactLastName !== undefined ? encryptField(fields.emergencyContactLastName) : null,
      fields.emergencyContactFirstName !== undefined ? encryptField(fields.emergencyContactFirstName) : null,
      fields.emergencyContactPhone !== undefined ? encryptField(fields.emergencyContactPhone) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}
```

(Every placeholder number from `$5` onward shifts up by one compared to the current file — recount every one against this new parameter array carefully, the same discipline this project's plans have required every time a shared SQL statement gains a new field. `fields.hotkeys ?? null` would be WRONG here — an empty object `{}` is a legitimate value a client might send to reset hotkeys to defaults, and `{} ?? null` still evaluates to `{}`, so that part is actually fine; but use `!== undefined` as shown above anyway, for consistency with every other optional non-required field in this same function, and because `JSON.stringify(fields.hotkeys)` must not be called at all when `fields.hotkeys` is `undefined`.)

- [ ] **Step 3: Write the tests**

Read `tests/integration/accounts.test.js`'s current top (imports, `registerLoginAndGetCookie` helper) and its existing `PATCH /account encrypts and returns sensitive fields...` test for the established style. Add these two tests right before the existing `test.after(...)` block:

```javascript
test('PATCH /account saves and returns hotkeys; GET /account defaults to an empty object', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await registerLoginAndGetCookie(port);

    const beforeRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    assert.deepEqual((await beforeRes.json()).hotkeys, {});

    const patchRes = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ hotkeys: { confirm: 'Enter', cancel: 'Escape', scan: ' ' } }),
    });
    assert.equal(patchRes.status, 200);
    assert.deepEqual((await patchRes.json()).hotkeys, { confirm: 'Enter', cancel: 'Escape', scan: ' ' });

    const afterRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    assert.deepEqual((await afterRes.json()).hotkeys, { confirm: 'Enter', cancel: 'Escape', scan: ' ' });
  });
});

test('PATCH /account omitting hotkeys preserves the previously-saved value', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await registerLoginAndGetCookie(port);

    await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ hotkeys: { confirm: 'k' } }),
    });

    const secondPatchRes = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ nickname: 'Unrelated Change' }),
    });
    const secondPatched = await secondPatchRes.json();
    assert.equal(secondPatched.nickname, 'Unrelated Change');
    assert.deepEqual(secondPatched.hotkeys, { confirm: 'k' });
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/integration/accounts.test.js --test-concurrency=1`
Expected: all PASS (existing tests in this file must still pass too — a placeholder-numbering mistake in Step 2 would most likely surface here as a wrong-value failure in one of the ALREADY-EXISTING tests, not just the two new ones).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/021_users_hotkeys.sql backend/accounts/repository.js tests/integration/accounts.test.js
git commit -m "feat: add users.hotkeys, self-service via PATCH /account"
```

---

### Task 2: Frontend — hotkey config UI and keydown wiring on the check-in page

**Files:**
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `hotkeys` field from `GET /account` / `PATCH /account` (Task 1).
- Consumes (unchanged): the existing `#scan-confirm`/`#scan-cancel` click handlers and `scanStartButton`'s click handler, all already defined in this file by the QR-Code-Erfassung plan — this task adds a keyboard trigger for each, it does not duplicate their logic.

- [ ] **Step 1: Add the config UI**

Read the current file first (this project's `admin/checkin.html` already has a "QR-Scan" card with a mode select and a scan-start button, from the QR-Code-Erfassung plan — re-read the file fresh, since line numbers will have shifted since that plan was written). Add a new small card right after the existing "QR-Scan" card's closing `</div>`, before `<dialog id="scan-dialog">`:

```html
    <div class="card form-pad">
      <h2>Hotkeys</h2>
      <p class="sub">Klicke in ein Feld und drücke die gewünschte Taste.</p>
      <label for="hotkey-confirm">Einchecken (im Pop-up)</label>
      <input id="hotkey-confirm" readonly>
      <label for="hotkey-cancel">Abbrechen (im Pop-up)</label>
      <input id="hotkey-cancel" readonly>
      <label for="hotkey-scan">Scan starten (Push-to-See)</label>
      <input id="hotkey-scan" readonly>
    </div>
```

- [ ] **Step 2: Implement capture, load, save, and the global listener**

In the `<script type="module">` block, add this constant near the top (alongside the other top-level constants like `STATUS_LABELS`):

```javascript
const DEFAULT_HOTKEYS = { confirm: 'Enter', cancel: 'Escape', scan: ' ' };
const HOTKEY_DISPLAY = { Enter: 'Enter', Escape: 'Esc', ' ': 'Leertaste' };
function displayKey(key) { return HOTKEY_DISPLAY[key] ?? key; }
```

Add this block (place it after the existing QR-scan-related listener registrations from the QR-Code-Erfassung plan, so it lands alongside that feature's own setup code — before the pre-existing top-level `try { const account = await api.get('/account'); ... }` block, matching this file's established rule against any new blocking top-level await):

```javascript
let currentHotkeys = { ...DEFAULT_HOTKEYS };

function renderHotkeyInputs() {
  document.getElementById('hotkey-confirm').value = displayKey(currentHotkeys.confirm);
  document.getElementById('hotkey-cancel').value = displayKey(currentHotkeys.cancel);
  document.getElementById('hotkey-scan').value = displayKey(currentHotkeys.scan);
}

function captureHotkey(inputId, action) {
  document.getElementById(inputId).addEventListener('keydown', async (event) => {
    // stopPropagation, not just preventDefault: preventDefault only blocks
    // the input's default keystroke behavior, it does NOT stop this event
    // from also bubbling up to the document-level listener below. Without
    // stopping it here, capturing a key would ALSO immediately re-trigger
    // whatever action that same key is (or was) already bound to.
    event.preventDefault();
    event.stopPropagation();
    currentHotkeys = { ...currentHotkeys, [action]: event.key };
    renderHotkeyInputs();
    try {
      await api.patch('/account', { hotkeys: currentHotkeys });
    } catch (err) {
      scanStatus.textContent = err.message;
    }
  });
}

captureHotkey('hotkey-confirm', 'confirm');
captureHotkey('hotkey-cancel', 'cancel');
captureHotkey('hotkey-scan', 'scan');

function isTypingTarget(el) {
  return el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

document.addEventListener('keydown', (event) => {
  if (!scanDialog.open && isTypingTarget(document.activeElement)) return;
  if (scanDialog.open) {
    if (event.key === currentHotkeys.confirm) {
      event.preventDefault();
      if (!document.getElementById('scan-confirm').disabled) document.getElementById('scan-confirm').click();
    } else if (event.key === currentHotkeys.cancel) {
      event.preventDefault();
      document.getElementById('scan-cancel').click();
    }
  } else if (event.key === currentHotkeys.scan && scanStartButton.style.display !== 'none') {
    event.preventDefault();
    scanStartButton.click();
  }
});
```

(`captureHotkey`'s own listener is attached directly to each hotkey-capture input, so the DOM guarantees it runs BEFORE this document-level bubble-phase listener for any keydown that starts inside that input — ordering is not the concern. The concern is that `event.preventDefault()` alone does not stop the SAME event from continuing to bubble up to `document` afterward. `captureHotkey`'s `event.stopPropagation()` is what actually prevents this global listener from also seeing (and potentially acting on) a keystroke that was meant purely to configure a hotkey. `isTypingTarget` therefore needs no special-case exclusion for the 3 capture-input ids — by the time any OTHER keydown reaches this listener, it is guaranteed not to have originated from one of them.)

- [ ] **Step 3: Load saved hotkeys on page load**

In the existing top-level `try { const account = await api.get('/account'); ... }` block, add this line right after the existing `canOverride = !!account.canOverrideCheckinStatus;` line:

```javascript
    currentHotkeys = { ...DEFAULT_HOTKEYS, ...(account.hotkeys ?? {}) };
    renderHotkeyInputs();
```

- [ ] **Step 4: Manual verification**

Start the dev server, use the Browser tool: log in as `admin@pakyrion.local`/`0000`, navigate to `/admin/checkin.html`. Confirm the "Hotkeys" card renders with the 3 default values shown (Enter / Esc / Leertaste). Click into the "Scan starten" hotkey field and press a different key (e.g. `s`) — confirm the field updates to show `s` and that `GET /account` (via `javascript_tool`, or reloading the page) reflects the saved change. Reload the page and confirm the changed hotkey persists across reload. Since a real popup requires a real camera scan (out of reach for this environment, per the QR-Code-Erfassung plan's own documented limitation), verify what CAN be verified without one: open the `<dialog id="scan-dialog">` manually via `javascript_tool` (`document.getElementById('scan-dialog').showModal()`), then dispatch a synthetic `keydown` event for the configured confirm/cancel key and confirm the corresponding button's `click()` fires (check via a temporary listener or by observing the dialog closes for cancel). Screenshot the Hotkeys card as evidence.

- [ ] **Step 5: Commit**

```bash
git add frontend/admin/checkin.html
git commit -m "feat: add configurable hotkeys for the QR-scan popup"
```

---

### Task 3: Full test suite

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

- Spec coverage: covers Plan 4 of `2026-09-01-qrcode-qol-design.md` in full — `users.hotkeys` storage, self-service via the ungated `PATCH /account` pattern (matching `firstName`/`lastName`), configuration UI on `admin/checkin.html` (not the general account page, since hotkeys only make sense in the check-in context), the 3 default assignments from the ORIGINAL user-authored spec (Enter/Esc/Space), and the scope explicitly named there (confirm check-in, cancel/close popup, start a push-to-see scan).
- Type/interface consistency: `{confirm, cancel, scan}` key names are used identically in the backend test's PATCH body, `DEFAULT_HOTKEYS`, and every function in Task 2's frontend code — no drift between what's stored and what's read.
- Dependency correctness: this plan's own Global Constraints and every Task 2 code block explicitly reuse the EXISTING `#scan-confirm`/`#scan-cancel`/`scanStartButton` click handlers from the QR-Code-Erfassung plan (already merged to master) rather than reimplementing check-in/cancel/scan-start logic — matching the spec's own explicit dependency note ("Plan 4 hängt vom Scan-Popup aus Plan 3 ab").
- A real event-propagation hazard specific to this task was caught and explicitly resolved during planning, not left implicit: capturing a hotkey means listening for `keydown` on the capture input itself, but `event.preventDefault()` there does NOT stop that same event from also bubbling up to the document-level global listener this task adds — without `event.stopPropagation()` in `captureHotkey`, the very keystroke used to CONFIGURE a hotkey would simultaneously be interpreted as an attempt to TRIGGER whatever action that key is already bound to. Solved with an explicit `stopPropagation()` call, not an id-exclusion list in the global listener's typing-guard (which would work too, but is more fragile — it would need updating every time a new capture input is added, where `stopPropagation` needs no such upkeep).
