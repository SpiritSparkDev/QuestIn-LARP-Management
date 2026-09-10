# Konto/Veranstaltung/Charaktere-Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `frontend/account.html`, `frontend/characters.html`, `frontend/con-anmeldungen.html` into one page with two levels of tabs (Konto / Veranstaltung → Anmelden / Charaktere), collapsing three nav entries into one.

**Architecture:** Pure frontend reshuffle — the three existing pages' markup and `<script type="module">` bodies get combined into one file, with ID/variable renames only where names collide across the merged files. No backend API changes. One backend-adjacent change: the `charaktere`/`con-anmeldungen` menu keys (used for per-group nav visibility) are retired since there's only one nav entry now.

**Tech Stack:** Vanilla JS (ES modules, no bundler), the project's existing `.tabs`/`.tab-btn`/`.tab-panel` CSS pattern (`frontend/css/chronicle-crest.css`), Node's built-in test runner (`node --test`) for backend tests.

**Spec:** `docs/superpowers/specs/2026-09-10-konto-veranstaltung-charaktere-wizard-design.md`

## Global Constraints

- No backend API changes (spec §3) — every `api.get`/`api.post`/`api.put`/`api.delete` call in the merged page must hit the exact same endpoint with the exact same payload shape it does today.
- No new CSS — reuse `.tabs`/`.tabs--sub`/`.tab-btn`/`.tab-panel` as-is (spec §6).
- No URL redirects for the deleted pages (spec §8, §10) — YAGNI, small user base, nav is the only regular access path.
- German UI copy stays exactly as in the source files being merged — this is a structural merge, not a wording pass.
- This repo has no frontend test framework (spec §9) — every frontend task's "test" step is a concrete manual browser checklist against the dev server, not an automated test.
- Backend/DB changes (Task 1 only) DO have automated coverage (`tests/integration/groups.test.js`, `tests/integration/seedGroups.test.js`) — run via `npm test` (uses `node --test`, needs `docker compose -f docker-compose.dev.yml up` running for the Postgres port per `CLAUDE.md`).

---

## Task 1: Retire the `charaktere`/`con-anmeldungen` menu keys

**Files:**
- Modify: `backend/groups/routes.js:9`
- Modify: `db/groupDefaults.js:4,10,16`
- Modify: `frontend/admin/groups.html:49-51`
- Create: `db/migrations/031_konto_menu_konsolidierung.sql`
- Modify: `tests/integration/groups.test.js` (new test)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `groups.visible_menus` rows and `MENU_KEYS` no longer contain `'charaktere'`/`'con-anmeldungen'` — Task 5's `nav.js` update assumes this is already true (every group that could see those two keys already has `'konto'`, verified in the spec §4).

- [ ] **Step 1: Write the new migration**

Create `db/migrations/031_konto_menu_konsolidierung.sql`:

```sql
-- Menu keys 'charaktere' and 'con-anmeldungen' are folded into the single
-- 'konto' page (Konto/Veranstaltung/Charaktere tabs on one page) -- see
-- docs/superpowers/specs/2026-09-10-konto-veranstaltung-charaktere-wizard-design.md.
-- Every group that currently shows either of those two also shows 'konto'
-- (verified against db/groupDefaults.js before writing this migration), so
-- no group loses access to the merged page by this update alone.
UPDATE groups SET visible_menus = (visible_menus - 'charaktere') - 'con-anmeldungen';
```

- [ ] **Step 2: Update `MENU_KEYS` in the backend**

In `backend/groups/routes.js`, change line 9 from:

```js
const MENU_KEYS = ['konto', 'charaktere', 'con-anmeldungen', 'mitglieder', 'events', 'checkin'];
```

to:

```js
const MENU_KEYS = ['konto', 'mitglieder', 'events', 'checkin'];
```

- [ ] **Step 3: Update `db/groupDefaults.js`**

Change all three `visibleMenus` arrays (lines 4, 10, 16) by removing `'charaktere'` and `'con-anmeldungen'`, keeping `'konto'`:

```js
export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut', 'group'],
    canEditCharacters: true, canOverrideCheckinStatus: true, isProtected: true,
  },
  {
    key: 'moderator', name: 'Moderator',
    visibleMenus: ['konto', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut'],
    canEditCharacters: true, canOverrideCheckinStatus: true, isProtected: false,
  },
  {
    key: 'mitglied', name: 'Mitglied',
    visibleMenus: ['konto'],
    accountFields: [], canEditCharacters: false, canOverrideCheckinStatus: false, isProtected: false,
  },
];
```

- [ ] **Step 4: Remove the two checkboxes from the admin groups UI**

In `frontend/admin/groups.html`, delete lines 50-51:

```html
          <label><input type="checkbox" value="charaktere"> Charaktere</label>
          <label><input type="checkbox" value="con-anmeldungen"> Con-Anmeldungen</label>
```

leaving only the `konto` checkbox (line 49) plus the other existing ones (`mitglieder`, `events`, `checkin`) untouched.

- [ ] **Step 5: Add a regression test for the retired menu key**

In `tests/integration/groups.test.js`, add a new test right after the existing `'POST /groups rejects an invalid menu key'` test (after line 115):

```js
test('POST /groups rejects the retired charaktere/con-anmeldungen menu keys', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `retired_${Date.now()}`, name: 'Retired', visibleMenus: ['charaktere'] }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 6: Run the affected test files**

Run: `npm test -- tests/integration/groups.test.js tests/integration/seedGroups.test.js`

Expected: all tests pass, including the new one and the existing `'every seeded group matches GROUP_DEFAULTS field-for-field'` test (which now compares against the reduced `visibleMenus` arrays on both sides — DB rows via migration 031, `GROUP_DEFAULTS` via Step 3).

If `docker compose -f docker-compose.dev.yml up` isn't already running, start it first (per `CLAUDE.md`, this is the dev compose file with the exposed Postgres port the tests connect to).

- [ ] **Step 7: Commit**

```bash
git add backend/groups/routes.js db/groupDefaults.js frontend/admin/groups.html db/migrations/031_konto_menu_konsolidierung.sql tests/integration/groups.test.js
git commit -m "$(cat <<'EOF'
feat: retire charaktere/con-anmeldungen menu keys

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Build the page skeleton with a working Konto tab

**Files:**
- Modify: `frontend/account.html` (full rewrite)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a generic `initTabs(tabsEl)` function (module-scope, in `account.html`'s script) that Task 3 and Task 4 both call for their own tab containers. Produces the outer tab shell: `#page-tabs` (buttons `data-tab="konto-tab"` / `data-tab="veranstaltung-tab"`), panels `#konto-tab` and `#veranstaltung-tab` (the latter empty until Task 3/4). Produces the single shared `#nav-links` and `#logout-link` elements Task 3/4's markup must NOT duplicate.

This task's markup for `#veranstaltung-tab` is an empty `<div class="tab-panel" id="veranstaltung-tab" hidden></div>` — Task 3 fills it in. The script's final bootstrap block only performs the Konto-tab initialization for now; Task 3 and Task 4 each extend it.

- [ ] **Step 1: Write the new `frontend/account.html`**

Replace the entire file with:

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mein Konto – Pakyrion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">
<link rel="stylesheet" href="/css/chronicle-crest.css">
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1/qrcode.min.js"></script>
</head>
<body>
<div class="shell">
  <div class="brand"><div class="brand-seal"></div><div class="brand-name">Pakyrion</div></div>
  <p class="brand-sub">QuestIn LARP Management</p>
  <div class="folio folio--wide">
    <nav class="app-nav" id="nav-links"></nav>
    <div class="header-actions">
      <button type="button" id="logout-link" class="btn-danger">
        <span class="material-symbols-outlined" aria-hidden="true">logout</span> Logout
      </button>
    </div>

    <div class="tabs" id="page-tabs">
      <button type="button" class="tab-btn active" data-tab="konto-tab">Konto</button>
      <button type="button" class="tab-btn" data-tab="veranstaltung-tab">Veranstaltung</button>
    </div>

    <div class="tab-panel" id="konto-tab">
      <h1>Mein Konto</h1>
      <form id="account-form">
        <div class="field-grid">
          <div><label for="firstName">Vorname *</label><input id="firstName" name="firstName" type="text" required></div>
          <div><label for="lastName">Nachname *</label><input id="lastName" name="lastName" type="text" required></div>
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
      <div id="qr-section" style="display:none;">
        <hr class="rule">
        <h2>Mein QR-Code</h2>
        <p class="lede" id="qr-hint"></p>
        <canvas id="qr-canvas"></canvas>
      </div>
      <p id="account-message"></p>
    </div>

    <div class="tab-panel" id="veranstaltung-tab" hidden></div>
  </div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { applyBranding } from '/js/branding.js';
applyBranding();
import { renderNavLinks } from '/js/nav.js';
import { attachBirthdateFormatter, attachLiveValidation } from '/js/formFields.js';
import { buildScanCode } from '/js/qrCode.js';

function initTabs(tabsEl) {
  const buttons = [...tabsEl.querySelectorAll('.tab-btn')];
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => {
        b.classList.toggle('active', b === btn);
        document.getElementById(b.dataset.tab).hidden = b !== btn;
      });
    });
  });
}

initTabs(document.getElementById('page-tabs'));

const accountForm = document.getElementById('account-form');
attachLiveValidation(accountForm);
const accountMessage = document.getElementById('account-message');
const accountFormControls = accountForm.querySelectorAll('input, textarea, button');
accountFormControls.forEach((el) => { el.disabled = true; });
attachBirthdateFormatter(document.getElementById('birthdate'));

document.getElementById('logout-link').addEventListener('click', async () => {
  if (!confirm('Wirklich abmelden?')) return;
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});

async function loadQrCode(account) {
  const qrSection = document.getElementById('qr-section');
  const qrHint = document.getElementById('qr-hint');
  try {
    const [qrEvents, qrRegistrations] = await Promise.all([api.get('/events'), api.get('/registrations')]);
    const activeEvent = qrEvents.find((e) => e.is_active);
    if (!activeEvent) {
      qrSection.style.display = '';
      qrHint.textContent = 'Aktuell ist kein Event für die Anmeldung geöffnet.';
      return;
    }
    if (!activeEvent.code) {
      qrSection.style.display = '';
      qrHint.textContent = 'Für dieses Event ist noch kein QR-Code eingerichtet.';
      return;
    }
    const registration = qrRegistrations.find((r) => r.eventId === activeEvent.id);
    if (!registration) {
      qrSection.style.display = '';
      qrHint.textContent = `Du bist für "${activeEvent.name}" nicht angemeldet.`;
      return;
    }

    const code = buildScanCode({ eventCode: activeEvent.code, groupKey: account.group.key, userId: account.id });
    const qr = qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    const moduleCount = qr.getModuleCount();
    const cellSize = 6;
    const canvas = document.getElementById('qr-canvas');
    canvas.width = moduleCount * cellSize;
    canvas.height = moduleCount * cellSize;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }

    qrSection.style.display = '';
    qrHint.textContent = `Für "${activeEvent.name}" — zeig diesen Code beim Check-In vor.`;
  } catch {
    // Branding-style fail-quiet: the QR section is a convenience, not core
    // account functionality, so a network hiccup here must not block or
    // error out the rest of the account page.
    qrSection.style.display = 'none';
  }
}

accountForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  accountMessage.textContent = '';
  accountMessage.className = '';
  const data = Object.fromEntries(new FormData(accountForm));
  try {
    await api.patch('/account', data);
    accountMessage.textContent = 'Gespeichert.';
    accountMessage.className = 'success';
  } catch (err) {
    accountMessage.textContent = err.message;
    accountMessage.className = 'error';
  }
});

try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);

  for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes']) {
    accountForm.elements[field].value = account[field] ?? '';
  }
  accountFormControls.forEach((el) => { el.disabled = false; });
  await loadQrCode(account);
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
</script>
</body>
</html>
```

- [ ] **Step 2: Manual verification**

Start the dev server (`docker compose -f docker-compose.dev.yml up`, per `CLAUDE.md`) and open `/account.html` in the browser, logged in as an existing test user:

1. Page loads, nav shows a single "Konto" link (still pointing to `/account.html` — `nav.js` isn't updated until Task 5, so it may currently show extra/stale links; that's expected and gets fixed in Task 5).
2. "Konto" tab is active by default, shows the OT form pre-filled with the account's data.
3. Click "Veranstaltung" tab — panel is empty (expected, filled in Task 3/4), "Konto" tab content hides.
4. Click back to "Konto" — form reappears with the same values (not reloaded/cleared).
5. Change a field (e.g. "Rufname"), click "Speichern" — "Gespeichert." message appears.
6. If an active event exists and the user is registered for it, the QR code renders below the form.
7. Click "Logout" — confirms, then redirects to `/login.html`.

- [ ] **Step 3: Commit**

```bash
git add frontend/account.html
git commit -m "$(cat <<'EOF'
feat: rebuild account.html as Konto/Veranstaltung tab shell

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Fill in the Anmelden sub-tab

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `initTabs(tabsEl)` from Task 2 (module-scope function, already in the file).
- Produces: `let characters = []` (module-scope, the full result of `GET /characters`) and `async function loadCharacters()` — Task 4 EXTENDS `loadCharacters()` (adds SC/NSC list rendering to the same function body) rather than redeclaring it, and reads/writes the same `characters` array for its own character-management list. Produces `#veranstaltung-subtabs` (buttons `data-tab="anmelden-subtab"` / `data-tab="charaktere-subtab"`), panel `#anmelden-subtab` (filled by this task) and empty panel `#charaktere-subtab` (filled by Task 4). Produces a `<button type="button" id="no-character-hint-btn">` inside the Anmelden form — Task 4 does not need to wire it (already wired here to click the Charaktere sub-tab button, which exists as of this task even though its panel is empty until Task 4).

- [ ] **Step 1: Add the Veranstaltung tab's sub-tab shell and Anmelden content**

In `frontend/account.html`, replace:

```html
    <div class="tab-panel" id="veranstaltung-tab" hidden></div>
```

with:

```html
    <div class="tab-panel" id="veranstaltung-tab" hidden>
      <div class="tabs tabs--sub" id="veranstaltung-subtabs">
        <button type="button" class="tab-btn active" data-tab="anmelden-subtab">Anmelden</button>
        <button type="button" class="tab-btn" data-tab="charaktere-subtab">Charaktere</button>
      </div>

      <div class="tab-panel" id="anmelden-subtab">
        <h2>Meine Anmeldungen</h2>
        <table id="registration-list">
          <thead><tr><th>Event</th><th>Rolle</th><th>Status</th><th></th></tr></thead>
          <tbody></tbody>
        </table>

        <dialog id="edit-ot-dialog">
          <h3>Anmeldungsdaten bearbeiten</h3>
          <p class="lede">Diese Änderung benachrichtigt die Orga und Admin dieses Events per E-Mail.</p>
          <div id="edit-ot-fields"></div>
          <div class="dialog-actions">
            <button type="button" id="edit-ot-save">Speichern</button>
            <button type="button" id="edit-ot-cancel" class="btn-ghost">Abbrechen</button>
          </div>
        </dialog>

        <h2>Neu anmelden</h2>
        <form id="registration-form">
          <label for="event-select">Event</label>
          <select id="event-select" required></select>

          <label for="con-role-select">Rolle</label>
          <select id="con-role-select">
            <option value="sc">SC</option>
            <option value="nsc">NSC</option>
            <option value="gsc">GSC</option>
            <option value="helfer">Helfer</option>
            <option value="orga" data-staff-only>Orga</option>
            <option value="hilfs_orga" data-staff-only>Hilfs-Orga</option>
          </select>

          <div id="character-select-wrap">
            <label for="character-select">Charakter</label>
            <select id="character-select"></select>
            <p id="no-character-hint" style="display:none;">Du hast noch keinen passenden Charakter. <button type="button" id="no-character-hint-btn" class="btn-ghost">Charakter anlegen</button></p>
          </div>

          <div id="dynamic-fields"></div>

          <h3>Weitere Angaben zu dieser Anmeldung</h3>
          <div id="ot-fields"></div>

          <button type="submit" id="register-button">Anmelden</button>
        </form>
        <p id="registration-message"></p>
      </div>

      <div class="tab-panel" id="charaktere-subtab" hidden></div>
    </div>
```

- [ ] **Step 2: Add the Anmelden sub-tab's script logic**

In `frontend/account.html`'s `<script type="module">`, change the import line:

```js
import { attachBirthdateFormatter, attachLiveValidation } from '/js/formFields.js';
```

to:

```js
import { escapeHtml, renderField, collectFieldValues, attachLiveValidation, attachBirthdateFormatter, STATUS_LABELS, renderEventOptions, renderAccountFieldInput, REGISTRATION_FIELD_LABELS, isOptOutYes, OPT_OUT_KEYS } from '/js/formFields.js';
```

Right after the `initTabs(document.getElementById('page-tabs'));` line, add:

```js
initTabs(document.getElementById('veranstaltung-subtabs'));
```

Then, right before the final bootstrap `try` block, add:

```js
const CON_ROLE_LABELS = { sc: 'SC', nsc: 'NSC', gsc: 'GSC', helfer: 'Helfer', orga: 'Orga', hilfs_orga: 'Hilfs-Orga' };

const registrationListBody = document.querySelector('#registration-list tbody');
const registrationForm = document.getElementById('registration-form');
attachLiveValidation(registrationForm);
const eventSelect = document.getElementById('event-select');
const conRoleSelect = document.getElementById('con-role-select');
const characterSelectWrap = document.getElementById('character-select-wrap');
const characterSelect = document.getElementById('character-select');
const noCharacterHint = document.getElementById('no-character-hint');
const dynamicFields = document.getElementById('dynamic-fields');
const registerButton = document.getElementById('register-button');
const registrationMessage = document.getElementById('registration-message');
const otFieldsContainer = document.getElementById('ot-fields');

let events = [];
let characters = [];
let canEditCharacters = false;
let isModeratorOrAdmin = false;
let currentUserId = null;

function renderOtFields(values = {}) {
  otFieldsContainer.innerHTML = Object.entries(REGISTRATION_FIELD_LABELS)
    .map(([key, label]) => renderAccountFieldInput(key, label, values[key], { idPrefix: 'register-' }))
    .join('');
  attachLiveValidation(otFieldsContainer);
}

function collectOtFields() {
  const result = {};
  otFieldsContainer.querySelectorAll('[data-field]').forEach((input) => {
    result[input.dataset.field] = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
  });
  return result;
}

function updateRegisterButtonLabel() {
  const event = events.find((e) => e.id === eventSelect.value);
  registerButton.textContent = event ? `Anmelden für ${event.name}` : 'Anmelden';
}

function classForConRole(conRole) {
  return conRole === 'nsc' ? 'nsc' : 'sc';
}

function populateCharacterOptions() {
  const conRole = conRoleSelect.value;
  const needsCharacter = ['sc', 'gsc', 'nsc'].includes(conRole);
  characterSelectWrap.style.display = needsCharacter ? '' : 'none';
  if (!needsCharacter) {
    dynamicFields.innerHTML = '';
    return;
  }
  const expectedClass = classForConRole(conRole);
  const matching = characters.filter((c) => c.class === expectedClass);
  characterSelect.innerHTML = matching.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  noCharacterHint.style.display = matching.length === 0 ? '' : 'none';
  renderDynamicFieldsForSelection();
}

function renderDynamicFieldsForSelection() {
  const event = events.find((e) => e.id === eventSelect.value);
  const character = characters.find((c) => c.id === characterSelect.value);
  const schema = event ? event.character_form_schema : [];
  const data = character ? character.data : {};
  dynamicFields.innerHTML = ['sc', 'gsc'].includes(conRoleSelect.value)
    ? schema.map((field) => renderField(field, data[field.key])).join('')
    : '';
  attachLiveValidation(dynamicFields);
}

conRoleSelect.addEventListener('change', populateCharacterOptions);
characterSelect.addEventListener('change', renderDynamicFieldsForSelection);
eventSelect.addEventListener('change', () => {
  updateRegisterButtonLabel();
  renderDynamicFieldsForSelection();
});

document.getElementById('no-character-hint-btn').addEventListener('click', () => {
  document.querySelector('#veranstaltung-subtabs [data-tab="charaktere-subtab"]').click();
});

function populateEventOptions() {
  const visibleEvents = canEditCharacters ? events : events.filter((e) => e.is_active);
  eventSelect.innerHTML = renderEventOptions(visibleEvents);
  updateRegisterButtonLabel();
}

async function loadEvents() {
  events = await api.get('/events');
  populateEventOptions();
}

async function loadCharacters() {
  characters = await api.get('/characters');
  populateCharacterOptions();
}

let currentRegistrations = [];
const editOtDialog = document.getElementById('edit-ot-dialog');
const editOtFieldsContainer = document.getElementById('edit-ot-fields');
let editingEventId = null;

function openEditOtDialog(eventId) {
  const registration = currentRegistrations.find((r) => r.eventId === eventId);
  if (!registration) return;
  editingEventId = eventId;
  editOtFieldsContainer.innerHTML = Object.entries(REGISTRATION_FIELD_LABELS)
    .map(([key, label]) => renderAccountFieldInput(key, label, registration[key], { idPrefix: 'edit-' }))
    .join('');
  attachLiveValidation(editOtFieldsContainer);
  editOtDialog.showModal();
}

document.getElementById('edit-ot-cancel').addEventListener('click', () => {
  editingEventId = null;
  editOtDialog.close();
});

document.getElementById('edit-ot-save').addEventListener('click', async () => {
  const registration = currentRegistrations.find((r) => r.eventId === editingEventId);
  const payload = {};
  editOtFieldsContainer.querySelectorAll('[data-field]').forEach((input) => {
    const key = input.dataset.field;
    const originalValue = registration?.[key] ?? '';
    // Only send a field that actually changed -- a save that touched nothing
    // must not PUT .../ot-fields, since a successful call mails every event
    // orga/hilfs_orga plus every admin/moderator.
    const changed = OPT_OUT_KEYS.includes(key) ? isOptOutYes(originalValue) !== input.checked : originalValue !== input.value;
    if (!changed) return;
    payload[key] = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
  });
  registrationMessage.textContent = '';
  registrationMessage.className = '';
  if (Object.keys(payload).length === 0) {
    editOtDialog.close();
    return;
  }
  try {
    await api.put(`/events/${editingEventId}/registrations/${currentUserId}/ot-fields`, payload);
    editOtDialog.close();
    registrationMessage.textContent = 'Gespeichert.';
    registrationMessage.className = 'success';
    await loadRegistrations();
  } catch (err) {
    registrationMessage.textContent = err.message;
    registrationMessage.className = 'error';
  }
});

async function loadRegistrations() {
  const registrations = await api.get('/registrations');
  currentRegistrations = registrations;
  registrationListBody.innerHTML = registrations.map((r) => {
    const label = STATUS_LABELS[r.status] ?? r.status;
    return `<tr>
    <td>${escapeHtml(r.eventName)}</td>
    <td>${escapeHtml(CON_ROLE_LABELS[r.conRole] ?? r.conRole)}</td>
    <td><span class="ribbon status-${escapeHtml(r.status)}">${escapeHtml(label)}</span></td>
    <td>
      <button type="button" data-edit-ot="${r.eventId}">Bearbeiten</button>
      ${r.status === 'pending' ? `<button type="button" data-unregister="${r.eventId}">Abmelden</button>` : ''}
    </td>
  </tr>`;
  }).join('');

  registrationListBody.querySelectorAll('[data-unregister]').forEach((button) => {
    button.addEventListener('click', () => unregister(button.dataset.unregister));
  });
  registrationListBody.querySelectorAll('[data-edit-ot]').forEach((button) => {
    button.addEventListener('click', () => openEditOtDialog(button.dataset.editOt));
  });
}

async function unregister(eventId) {
  if (!confirm('Wirklich von diesem Event abmelden?')) return;
  registrationMessage.textContent = '';
  registrationMessage.className = '';
  try {
    await api.delete(`/events/${eventId}/register`);
    await loadRegistrations();
  } catch (err) {
    registrationMessage.textContent = err.message;
    registrationMessage.className = 'error';
  }
}

registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  registrationMessage.textContent = '';
  registrationMessage.className = '';
  const eventId = eventSelect.value;
  const conRole = conRoleSelect.value;
  const needsCharacter = ['sc', 'gsc', 'nsc'].includes(conRole);
  const characterId = needsCharacter ? characterSelect.value : undefined;
  if (needsCharacter && !characterId) return;

  try {
    if (['sc', 'gsc'].includes(conRole)) {
      const schema = events.find((e) => e.id === eventId)?.character_form_schema ?? [];
      const data = collectFieldValues(registrationForm, schema);
      await api.put(`/characters/${characterId}`, { eventId, data });
    }
    await api.post(`/events/${eventId}/register`, { conRole, characterId, otFields: collectOtFields() });
    registrationMessage.textContent = 'Angemeldet.';
    registrationMessage.className = 'success';
    renderOtFields();
    await loadRegistrations();
  } catch (err) {
    registrationMessage.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    registrationMessage.className = 'error';
  }
});
```

Now extend the final bootstrap `try` block. Change:

```js
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);

  for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes']) {
    accountForm.elements[field].value = account[field] ?? '';
  }
  accountFormControls.forEach((el) => { el.disabled = false; });
  await loadQrCode(account);
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
```

to:

```js
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);

  for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes']) {
    accountForm.elements[field].value = account[field] ?? '';
  }
  accountFormControls.forEach((el) => { el.disabled = false; });
  await loadQrCode(account);

  currentUserId = account.id;
  canEditCharacters = account.canEditCharacters;
  isModeratorOrAdmin = account.group?.key === 'admin' || account.group?.key === 'moderator';
  if (!isModeratorOrAdmin) {
    document.querySelectorAll('#con-role-select option[data-staff-only]').forEach((opt) => opt.remove());
  }
  renderOtFields();
  await loadEvents();
  await loadCharacters();
  await loadRegistrations();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
```

- [ ] **Step 3: Manual verification**

Reload `/account.html`, logged in as a user who is not admin/moderator:

1. Click "Veranstaltung" tab — "Anmelden" sub-tab is active, shows "Meine Anmeldungen" table (populated from existing registrations, or empty) and the "Neu anmelden" form below it.
2. Role dropdown has no "Orga"/"Hilfs-Orga" options (staff-only, removed for non-staff).
3. Pick an active event and role "SC" — character dropdown populates with the account's SC characters (if any) and event-schema fields render below.
4. If the account has no SC character yet: the "kein passender Charakter" hint shows with an "Charakter anlegen" button; click it — it switches to the "Charaktere" sub-tab (panel is empty, expected until Task 4) and the "Anmelden" sub-tab's own content is hidden, confirming the click-forwarding works.
5. Go back to "Anmelden", fill and submit a registration for a role that needs no character (e.g. "Helfer") — success message appears, "Meine Anmeldungen" table updates.
6. Click "Bearbeiten" on an existing registration row — the OT-fields dialog opens; "Abbrechen" closes it without changes.
7. Reload the page (F5) — everything above still works from a cold load (bootstrap block runs once, in order).

- [ ] **Step 4: Commit**

```bash
git add frontend/account.html
git commit -m "$(cat <<'EOF'
feat: fill in Veranstaltung > Anmelden sub-tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Fill in the Charaktere sub-tab

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `initTabs(tabsEl)` (Task 2), `characters` array + `loadCharacters()` (Task 3, extended by this task), `escapeHtml`/`renderField`/`collectFieldValues`/`attachLiveValidation` (already imported in Task 3).
- Produces: nothing further tasks depend on — Task 5 only touches `nav.js`, deletes files, and fixes one unrelated link.

- [ ] **Step 1: Add the Charaktere sub-tab's markup**

In `frontend/account.html`, replace:

```html
      <div class="tab-panel" id="charaktere-subtab" hidden></div>
```

with:

```html
      <div class="tab-panel" id="charaktere-subtab" hidden>
        <h2>Meine Charaktere</h2>
        <p><a href="/characters-browse.html">Charaktere anderer Spieler durchsuchen</a></p>

        <div class="tabs" id="char-class-tabs">
          <button type="button" class="tab-btn active" data-tab="sc-tab">Charaktere</button>
          <button type="button" class="tab-btn" data-tab="nsc-tab" id="nsc-tab-btn" style="display:none;">NSC-Charaktere</button>
        </div>

        <div class="tab-panel" id="sc-tab">
          <div id="character-list" class="char-grid"></div>

          <div id="sc-form-section" style="display:none;">
            <h3 id="form-title">Neuen Charakter anlegen</h3>
            <form id="character-form">
              <label for="character-name">Charaktername</label>
              <input id="character-name" name="name" type="text" required>
              <button type="submit">Speichern</button>
            </form>
            <p id="character-message"></p>
          </div>
        </div>

        <div class="tab-panel" id="nsc-tab" hidden>
          <div id="nsc-section" style="display:none;">
            <div id="nsc-character-list" class="char-grid"></div>

            <div class="tabs tabs--sub" id="nsc-form-tabs">
              <button type="button" class="tab-btn active" data-tab="nsc-form-general">Allgemein</button>
              <button type="button" class="tab-btn" data-tab="nsc-form-details">Merkmale</button>
            </div>

            <form id="nsc-character-form">
              <div class="tab-panel" id="nsc-form-general">
                <h3 id="nsc-form-title">Neuen NSC-Charakter anlegen</h3>
                <label for="nsc-character-name">Charaktername</label>
                <input id="nsc-character-name" name="name" type="text" required>
              </div>
              <div class="tab-panel" id="nsc-form-details" hidden>
                <div id="nsc-dynamic-fields"></div>
              </div>
              <button type="submit">Speichern</button>
              <button type="button" id="nsc-cancel-edit" style="display:none;" class="btn-ghost">Abbrechen</button>
            </form>
            <p id="nsc-message"></p>
          </div>
        </div>
      </div>
```

(Note: the original `characters.html` used `<h2 id="form-title">` for "Neuen Charakter anlegen" — demoted to `<h3>` here since it now sits one heading level deeper, under the sub-tab's own `<h2>Meine Charaktere</h2>`.)

- [ ] **Step 2: Add the Charaktere sub-tab's script logic**

Right after the `initTabs(document.getElementById('veranstaltung-subtabs'));` line (added in Task 3), add:

```js
initTabs(document.getElementById('char-class-tabs'));
initTabs(document.getElementById('nsc-form-tabs'));
```

Then, right before the final bootstrap `try` block, add:

```js
const scFormSection = document.getElementById('sc-form-section');
const characterForm = document.getElementById('character-form');
attachLiveValidation(characterForm);
const characterMessage = document.getElementById('character-message');
const characterListBody = document.getElementById('character-list');
const characterFormTitle = document.getElementById('form-title');

let nscSchema = [];
let nscCharacters = [];
let editingNscCharacterId = null;

const nscSection = document.getElementById('nsc-section');
const nscListBody = document.getElementById('nsc-character-list');
const nscForm = document.getElementById('nsc-character-form');
attachLiveValidation(nscForm);
const nscMessage = document.getElementById('nsc-message');
const nscFormTitle = document.getElementById('nsc-form-title');
const nscDynamicFields = document.getElementById('nsc-dynamic-fields');
const nscCancelButton = document.getElementById('nsc-cancel-edit');
const nscTabButton = document.getElementById('nsc-tab-btn');

let editingCharacterId = null;

const FILE_MIME_ALLOWLIST = { image: ['image/jpeg', 'image/png', 'image/webp'], document: ['application/pdf'] };

function kindForMimeType(mimeType) {
  if (FILE_MIME_ALLOWLIST.image.includes(mimeType)) return 'image';
  if (FILE_MIME_ALLOWLIST.document.includes(mimeType)) return 'document';
  return null;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderFileList(characterId, files) {
  const items = files.map((f) => {
    const url = `/characters/${characterId}/files/${f.id}`;
    const preview = f.kind === 'image'
      ? `<a href="${url}" target="_blank"><img src="${url}" alt="${escapeHtml(f.original_filename)}" style="max-width:80px;max-height:80px;"></a>`
      : `<a href="${url}" target="_blank">${escapeHtml(f.original_filename)}</a>`;
    return `<div class="file-item">
      ${preview}
      <span class="tag">${f.is_public ? 'Öffentlich' : 'Privat'}</span>
      <button type="button" data-delete-file="${f.id}" data-delete-character="${characterId}" class="btn-ghost">Löschen</button>
    </div>`;
  }).join('');

  return `${items}
    <form data-upload-form="${characterId}" class="file-upload-form">
      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required>
      <label><input type="checkbox" required> Ich habe den Hinweis gelesen</label>
      <label><input type="checkbox"> Öffentlich sichtbar</label>
      <button type="submit">Hochladen</button>
      <p class="upload-status"></p>
    </form>
    <p class="sub">Mit dem Hochladen bestätigst du, dass du die Rechte an dieser Datei besitzt und einverstanden bist, dass sie im Rahmen der Veranstaltung von berechtigten Personen eingesehen werden kann.</p>`;
}

async function loadFilesInto(characterId) {
  const container = document.querySelector(`[data-files-for="${characterId}"]`);
  if (!container) return;
  try {
    const files = await api.get(`/characters/${characterId}/files`);
    container.innerHTML = renderFileList(characterId, files);
    wireFileSection(characterId, container);
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function wireFileSection(characterId, container) {
  container.querySelectorAll('[data-delete-file]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Datei wirklich löschen?')) return;
      try {
        await api.delete(`/characters/${button.dataset.deleteCharacter}/files/${button.dataset.deleteFile}`);
        await loadFilesInto(characterId);
      } catch (err) {
        container.querySelector('.upload-status').textContent = err.message;
      }
    });
  });

  const uploadForm = container.querySelector(`[data-upload-form="${characterId}"]`);
  const fileInput = uploadForm.querySelector('input[type="file"]');
  const consentCheckbox = uploadForm.querySelector('input[type="checkbox"][required]');
  const publicCheckbox = uploadForm.querySelectorAll('input[type="checkbox"]')[1];
  const status = uploadForm.querySelector('.upload-status');
  const submitButton = uploadForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  consentCheckbox.addEventListener('change', () => { submitButton.disabled = !consentCheckbox.checked; });

  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = '';
    const file = fileInput.files[0];
    if (!file) return;
    const kind = kindForMimeType(file.type);
    if (!kind) {
      status.textContent = 'Nicht unterstützter Dateityp.';
      return;
    }
    try {
      const dataBase64 = await readFileAsBase64(file);
      await api.post(`/characters/${characterId}/files`, {
        kind, filename: file.name, mimeType: file.type, dataBase64,
        isPublic: publicCheckbox.checked, gdprConsent: consentCheckbox.checked,
      });
      await loadFilesInto(characterId);
    } catch (err) {
      status.textContent = err.message;
    }
  });
}

function tagValueForField(field, rawValue) {
  if (field.type === 'multiselect') {
    return Array.isArray(rawValue) && rawValue.length > 0 ? rawValue.join(', ') : undefined;
  }
  if (field.type === 'boolean') {
    return rawValue ? 'Ja' : undefined;
  }
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return undefined;
  }
  return rawValue;
}

function tagsForCharacter(c) {
  return Object.entries(c.data ?? {})
    .map(([key, value]) => ({ key, value: tagValueForField({ type: typeof value === 'boolean' ? 'boolean' : Array.isArray(value) ? 'multiselect' : 'text' }, value) }))
    .filter(({ value }) => value !== undefined)
    .map(({ key, value }) => `<span class="tag">${escapeHtml(key)}: ${escapeHtml(value)}</span>`)
    .join('');
}

function renderNscSchemaFields(data = {}) {
  nscDynamicFields.innerHTML = nscSchema.map((field) => renderField(field, data[field.key])).join('');
  attachLiveValidation(nscDynamicFields);
}

function tagsForNscCharacter(c) {
  return nscSchema
    .map((field) => ({ field, value: tagValueForField(field, c.data[field.key]) }))
    .filter(({ value }) => value !== undefined)
    .map(({ field, value }) => `<span class="tag">${escapeHtml(field.label || field.key)}: ${escapeHtml(value)}</span>`)
    .join('');
}

function renderNscList() {
  nscListBody.innerHTML = nscCharacters.map((c) => `<div class="char-card">
      <h3>${escapeHtml(c.name)}</h3>
      <div class="char-tags">${tagsForNscCharacter(c)}</div>
      <button type="button" data-nsc-edit="${c.id}" class="btn-ghost" style="margin-top:14px;">Bearbeiten</button>
      <div class="char-files" data-files-for="${c.id}">
        <p class="sub">Dateien werden geladen …</p>
      </div>
    </div>`).join('');

  nscListBody.querySelectorAll('[data-nsc-edit]').forEach((button) => {
    button.addEventListener('click', () => startNscEdit(button.dataset.nscEdit));
  });
  nscCharacters.forEach((c) => loadFilesInto(c.id));
}

function startNscEdit(characterId) {
  const character = nscCharacters.find((c) => c.id === characterId);
  if (!character) return;
  editingNscCharacterId = characterId;
  nscFormTitle.textContent = `NSC-Charakter bearbeiten: ${character.name}`;
  nscForm.elements.name.value = character.name;
  renderNscSchemaFields(character.data);
  nscForm.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
  nscCancelButton.style.display = '';
}

function resetNscForm() {
  editingNscCharacterId = null;
  nscFormTitle.textContent = 'Neuen NSC-Charakter anlegen';
  nscForm.reset();
  renderNscSchemaFields();
  nscForm.querySelector('button[type="submit"]').textContent = 'Speichern';
  nscCancelButton.style.display = 'none';
}

nscCancelButton.addEventListener('click', resetNscForm);

nscForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  nscMessage.textContent = '';
  nscMessage.className = '';
  const name = nscForm.elements.name.value;
  const data = collectFieldValues(nscForm, nscSchema);
  try {
    if (editingNscCharacterId) {
      await api.put(`/characters/${editingNscCharacterId}`, { name, data });
    } else {
      await api.post('/characters', { class: 'nsc', name, data });
    }
    nscMessage.textContent = 'Gespeichert.';
    nscMessage.className = 'success';
    resetNscForm();
    await loadCharacters();
  } catch (err) {
    nscMessage.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    nscMessage.className = 'error';
  }
});

function renderCharacterList() {
  const scCharacters = characters.filter((c) => c.class !== 'nsc');
  characterListBody.innerHTML = scCharacters.map((c) => {
    const tagsHtml = tagsForCharacter(c);
    return `<div class="char-card">
      <h3>${escapeHtml(c.name)}</h3>
      <div class="char-tags">${tagsHtml}</div>
      <button type="button" data-edit="${c.id}" class="btn-ghost" style="margin-top:14px;">Bearbeiten</button>
      <div class="char-files" data-files-for="${c.id}">
        <p class="sub">Dateien werden geladen …</p>
      </div>
    </div>`;
  }).join('');

  characterListBody.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => startEdit(button.dataset.edit));
  });
  scCharacters.forEach((c) => loadFilesInto(c.id));

  if (nscSection.style.display !== 'none') {
    nscCharacters = characters.filter((c) => c.class === 'nsc');
    renderNscList();
  }
}

function startEdit(characterId) {
  const character = characters.find((c) => c.id === characterId);
  if (!character) return;
  editingCharacterId = characterId;
  characterFormTitle.textContent = `Charakter bearbeiten: ${character.name}`;
  characterForm.elements.name.value = character.name;
  characterForm.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
}

function resetCharacterForm() {
  editingCharacterId = null;
  characterFormTitle.textContent = 'Neuen Charakter anlegen';
  characterForm.reset();
  characterForm.querySelector('button[type="submit"]').textContent = 'Speichern';
}

characterForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  characterMessage.textContent = '';
  characterMessage.className = '';
  const name = characterForm.elements.name.value;
  try {
    if (editingCharacterId) {
      await api.put(`/characters/${editingCharacterId}`, { name });
    } else {
      await api.post('/characters', { class: 'sc', name });
    }
    characterMessage.textContent = 'Gespeichert.';
    characterMessage.className = 'success';
    resetCharacterForm();
    await loadCharacters();
  } catch (err) {
    characterMessage.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    characterMessage.className = 'error';
  }
});
```

Now extend `loadCharacters()` (defined in Task 3) to also render the Charaktere sub-tab's lists. Change:

```js
async function loadCharacters() {
  characters = await api.get('/characters');
  populateCharacterOptions();
}
```

to:

```js
async function loadCharacters() {
  characters = await api.get('/characters');
  populateCharacterOptions();
  renderCharacterList();
}
```

Finally, extend the bootstrap `try` block again. Change:

```js
  renderOtFields();
  await loadEvents();
  await loadCharacters();
  await loadRegistrations();
} catch (err) {
```

to:

```js
  renderOtFields();

  scFormSection.style.display = '';
  nscSchema = await api.get('/nsc-schema');
  nscSection.style.display = '';
  nscTabButton.style.display = '';
  renderNscSchemaFields();

  await loadEvents();
  await loadCharacters();
  await loadRegistrations();
} catch (err) {
```

- [ ] **Step 3: Manual verification**

Reload `/account.html`:

1. Go to Veranstaltung → Charaktere. "Charaktere" (SC) sub-tab is active by default, "NSC-Charaktere" sub-tab button is visible (schema loaded).
2. Existing SC characters list as cards with tags and an "Bearbeiten" button; file-upload section loads under each ("Dateien werden geladen …" then the actual list).
3. Create a new SC character (name only) — appears in the list, "Gespeichert." message shows.
4. Switch to "NSC-Charaktere" sub-tab — list of NSC characters with their Merkmale tags. Create one: fill name in "Allgemein" sub-sub-tab, switch to "Merkmale" sub-sub-tab, fill schema fields, submit — saved and listed.
5. Edit an existing SC character's name — "Bearbeiten"-Formular pre-fills, save updates the card.
6. Upload a file (image or PDF) to a character — consent checkbox gates the submit button, upload succeeds, file appears with a "Löschen" button; delete it and confirm it's removed.
7. Go back to Veranstaltung → Anmelden, pick role "SC" — the character you just created is now in the dropdown (confirms `loadCharacters()`'s two responsibilities — populating the Anmelden dropdown and rendering the Charaktere lists — both ran from the one shared array).
8. Complete a registration using that new character, with event-schema fields filled — succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/account.html
git commit -m "$(cat <<'EOF'
feat: fill in Veranstaltung > Charaktere sub-tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire up navigation, delete the old pages, final end-to-end pass

**Files:**
- Modify: `frontend/js/nav.js`
- Modify: `frontend/characters-browse.html:20`
- Delete: `frontend/characters.html`
- Delete: `frontend/con-anmeldungen.html`

**Interfaces:**
- Consumes: Task 1's retired menu keys (so `nav.js` filtering by `account.menus.includes(item.key)` still works correctly with only `konto` in the list), Task 2-4's fully working `account.html`.
- Produces: nothing further — this is the plan's final task.

- [ ] **Step 1: Update `frontend/js/nav.js`**

Change:

```js
const MENU_LINKS = [
  { key: 'konto', label: 'Konto', href: '/account.html' },
  { key: 'charaktere', label: 'Charaktere', href: '/characters.html' },
  { key: 'con-anmeldungen', label: 'Con-Anmeldungen', href: '/con-anmeldungen.html' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html' },
  { key: 'events', label: 'Events', href: '/admin/events.html' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html' },
];
```

to:

```js
const MENU_LINKS = [
  { key: 'konto', label: 'Konto', href: '/account.html' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html' },
  { key: 'events', label: 'Events', href: '/admin/events.html' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html' },
];
```

- [ ] **Step 2: Fix the back-link in `characters-browse.html`**

In `frontend/characters-browse.html`, change line 20 from:

```html
    <p><a href="/characters.html">← Zurück zu meinen Charakteren</a></p>
```

to:

```html
    <p><a href="/account.html">← Zurück zu meinen Charakteren</a></p>
```

- [ ] **Step 3: Delete the two absorbed pages**

```bash
git rm frontend/characters.html frontend/con-anmeldungen.html
```

- [ ] **Step 4: Manual end-to-end verification**

With the dev server running, log in as each of the three roles below and confirm:

1. **`mitglied` user:** Nav shows exactly one link, "Konto". Visiting `/characters.html` or `/con-anmeldungen.html` directly gives a 404 (expected, no redirect per spec §10). The full flow from the spec's motivating example works end to end: Konto tab → fill/save OT data → Veranstaltung tab → Anmelden sub-tab → pick event+role → no character yet → click hint button → Charaktere sub-tab → create a character → back to Anmelden → character now selectable → submit registration → appears in "Meine Anmeldungen".
2. **`moderator` user:** Nav shows "Konto", "Mitglieder", "Events", "Check-In" (no "Charaktere"/"Con-Anmeldungen" — merged into "Konto"). Event dropdown in Anmelden includes inactive events too (per `canEditCharacters`).
3. **`admin` user:** Same nav as moderator plus "Gruppen"/"Einstellungen"/"Branding"/"Speicher" (unchanged, `nav.js` still appends those for `admin`). Open `admin/groups.html`, confirm only "Konto" checkbox remains (no "Charaktere"/"Con-Anmeldungen"), edit a custom group's menus, save, reload — persists correctly.
4. From `characters-browse.html` (link reachable from the Charaktere sub-tab), confirm the "← Zurück zu meinen Charakteren" link goes to `/account.html` and lands on the Charaktere sub-tab context correctly (it will land on the default Konto tab — that's expected, no deep-linking per spec §3 non-goal — just confirm the link doesn't 404).

- [ ] **Step 5: Run the full backend test suite**

Run: `npm test`

Expected: all tests pass (this task touches no backend code, but this is the final task of the plan — confirm nothing in Tasks 1-4 broke anything).

- [ ] **Step 6: Commit**

```bash
git add frontend/js/nav.js frontend/characters-browse.html
git commit -m "$(cat <<'EOF'
feat: wire nav to the merged account.html, drop old character/registration pages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
