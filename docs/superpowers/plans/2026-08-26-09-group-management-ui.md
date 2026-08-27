# Group Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins create and edit groups (menus/fields/can-edit-characters) through a UI instead of raw SQL, and replace every page's ad-hoc/static nav with one shared, menu-driven `nav.js` — closing the original "back from admin to normal area" request properly (admin pages currently have no link back to Konto/Charaktere at all).

**Architecture:** `backend/groups/` (repository + routes) exposes `GET/POST/PUT /groups`, gated by a new `requireAdminGroup` middleware (hardcoded to `group.key === 'admin'`, per the spec's explicit anti-governance-paradox design — not itself a configurable menu permission). `frontend/js/nav.js` is a small pure-function module (`renderNavLinks(account, currentPath)`) that both themes' pages call identically after fetching `/account`; every authenticated page's nav container becomes a single empty `<nav id="nav-links">` populated entirely at runtime. `admin/groups.html` is a new Everest-Registry-themed page mirroring `admin/events.html`'s existing list+form interaction pattern.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step.

**Spec:** `docs/superpowers/specs/2026-08-26-gruppen-berechtigungen-design.md`

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- Every existing test must still pass; `npm test` must stay green after every task.
- Fixed menu-key vocabulary (from the groups-foundation plan, unchanged): `konto`, `charaktere`, `mitglieder`, `events`, `checkin`.
- Fixed account-field-key vocabulary (unchanged): `address`, `birthdate`, `phone`, `emergencyContact`, `medicalNotes`, `group`.
- **The `admin` group's permissions are never editable via this UI or its API** — `PUT /groups/:id` must reject (403) any attempt to modify the group whose `is_protected` column is `true`. This is enforced server-side, not just hidden in the UI (defense in depth, matching this codebase's established pattern).
- Group management access itself (`GET/POST/PUT /groups`) is **hardcoded** to `user.group.key === 'admin'` — it is deliberately NOT a configurable menu permission (the spec's explicit anti-governance-paradox decision: no group should be able to grant itself or others group-editing rights via the very system being edited). Because of this, the "Gruppen" nav link is shown based on `account.group.key === 'admin'` directly, not via the `menus` array — see Task 2.
- **Known, deliberate, temporary gap this plan accepts:** the shared nav will render a "Mitglieder" link (`/admin/members.html`) for any group whose `menus` includes `mitglieder` (today: `admin`, `orga`) even though that page doesn't exist until the next plan (Member Management) lands. This plan is being executed immediately before that one in the same session — do not "fix" this by omitting the link; the next plan closes the gap. Do not build `/admin/members.html` as a stub in this plan either — that's out of scope and would just be thrown away.
- Verify visually via Claude Browser tools against the running dev stack for every page you touch.

---

### Task 1: Backend — `groups` CRUD API

**Files:**
- Create: `backend/groups/repository.js`
- Create: `backend/groups/routes.js`
- Modify: `backend/middleware/authorize.js` (add `requireAdminGroup`)
- Modify: `backend/server.js` (register the new route module)
- Create: `tests/integration/groups.test.js`

**Interfaces:**
- Produces: `export function requireAdminGroup(handler)` from `backend/middleware/authorize.js` — same composition shape as `requireAuth`/`requireMenu`, used as `requireAuth(requireAdminGroup(handler))`. `GET /groups`, `POST /groups`, `PUT /groups/:id` — all admin-only, JSON bodies/responses matching this codebase's existing REST conventions (see `backend/events/routes.js` for the pattern to mirror).

- [ ] **Step 1: Write `backend/groups/repository.js`**

```javascript
import { query } from '../db.js';

const SELECT_COLUMNS = 'id, key, name, visible_menus, account_fields, can_edit_characters, is_protected';

export async function listGroups() {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups ORDER BY name`);
  return rows;
}

export async function getGroup(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createGroup({ key, name, visibleMenus, accountFields, canEditCharacters }) {
  const { rows } = await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [key, name, JSON.stringify(visibleMenus ?? []), JSON.stringify(accountFields ?? []), !!canEditCharacters]
  );
  return rows[0];
}

export async function updateGroup(id, { name, visibleMenus, accountFields, canEditCharacters }) {
  const { rows } = await query(
    `UPDATE groups SET
       name = COALESCE($2, name),
       visible_menus = COALESCE($3, visible_menus),
       account_fields = COALESCE($4, account_fields),
       can_edit_characters = COALESCE($5, can_edit_characters)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      name ?? null,
      visibleMenus !== undefined ? JSON.stringify(visibleMenus) : null,
      accountFields !== undefined ? JSON.stringify(accountFields) : null,
      canEditCharacters !== undefined ? canEditCharacters : null,
    ]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Add `requireAdminGroup` to `backend/middleware/authorize.js`**

Add this export alongside the existing `requireMenu` (don't remove or modify `requireMenu`):

```javascript
export function requireAdminGroup(handler) {
  return async (ctx) => {
    if (!ctx.user) return { status: 401, body: { error: 'not authenticated' } };
    if (ctx.user.group.key !== 'admin') return { status: 403, body: { error: 'forbidden' } };
    return handler(ctx);
  };
}
```

- [ ] **Step 3: Write `backend/groups/routes.js`**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listGroups, getGroup, createGroup, updateGroup } from './repository.js';

const MENU_KEYS = ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'];
const ACCOUNT_FIELD_KEYS = ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'group'];
const KEY_PATTERN = /^[a-z0-9_]+$/;

function isValidMenuList(value) {
  return Array.isArray(value) && value.every((v) => MENU_KEYS.includes(v));
}

function isValidFieldList(value) {
  return Array.isArray(value) && value.every((v) => ACCOUNT_FIELD_KEYS.includes(v));
}

router.get('/groups', requireAuth(requireAdminGroup(async () => {
  const groups = await listGroups();
  return { status: 200, body: groups };
})));

router.post('/groups', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { key, name, visibleMenus, accountFields, canEditCharacters } = body;
  if (!key || !KEY_PATTERN.test(key)) {
    return { status: 400, body: { error: 'key is required and must contain only lowercase letters, digits, and underscores' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }
  if (visibleMenus !== undefined && !isValidMenuList(visibleMenus)) {
    return { status: 400, body: { error: `visibleMenus must be an array containing only: ${MENU_KEYS.join(', ')}` } };
  }
  if (accountFields !== undefined && !isValidFieldList(accountFields)) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${ACCOUNT_FIELD_KEYS.join(', ')}` } };
  }
  try {
    const group = await createGroup({ key, name, visibleMenus, accountFields, canEditCharacters });
    return { status: 201, body: group };
  } catch (err) {
    if (err.code === '23505') return { status: 409, body: { error: 'a group with this key already exists' } };
    throw err;
  }
})));

router.put('/groups/:id', requireAuth(requireAdminGroup(async ({ req, params }) => {
  const existing = await getGroup(params.id);
  if (!existing) return { status: 404, body: { error: 'group not found' } };
  if (existing.is_protected) {
    return { status: 403, body: { error: "the admin group's permissions cannot be edited" } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { visibleMenus, accountFields } = body;
  if (visibleMenus !== undefined && !isValidMenuList(visibleMenus)) {
    return { status: 400, body: { error: `visibleMenus must be an array containing only: ${MENU_KEYS.join(', ')}` } };
  }
  if (accountFields !== undefined && !isValidFieldList(accountFields)) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${ACCOUNT_FIELD_KEYS.join(', ')}` } };
  }
  const group = await updateGroup(params.id, body);
  return { status: 200, body: group };
})));
```

- [ ] **Step 4: Register the route module**

In `backend/server.js`, add this line alongside the other route-module imports (after `import './registrations/routes.js';`):

```javascript
import './groups/routes.js';
```

- [ ] **Step 5: Write the failing tests first**

Create `tests/integration/groups.test.js` (mirrors `tests/integration/events.test.js`'s structure and conventions — read that file first for the exact `makeUserAndSession`/session-cookie pattern used throughout this codebase):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createServer } = await import('../../backend/server.js');

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Groups Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`groups-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /groups rejects a non-admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/groups`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('GET /groups returns all 8 seeded groups for an admin', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const groups = await res.json();
    assert.ok(groups.length >= 8);
    assert.ok(groups.some((g) => g.key === 'sc'));
  } finally {
    server.close();
  }
});

test('POST /groups creates a new custom group with no permissions by default', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `custom_${Date.now()}`, name: 'Custom Group' }),
    });
    assert.equal(res.status, 201);
    const group = await res.json();
    assert.deepEqual(group.visible_menus, []);
    assert.deepEqual(group.account_fields, []);
    assert.equal(group.can_edit_characters, false);
    assert.equal(group.is_protected, false);
  } finally {
    server.close();
  }
});

test('POST /groups rejects a duplicate key', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const key = `dup_${Date.now()}`;
    await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key, name: 'First' }),
    });
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key, name: 'Second' }),
    });
    assert.equal(res.status, 409);
  } finally {
    server.close();
  }
});

test('POST /groups rejects an invalid menu key', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `bad_${Date.now()}`, name: 'Bad', visibleMenus: ['not_a_real_menu'] }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PUT /groups/:id updates a non-protected group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `editable_${Date.now()}`, name: 'Editable' }),
    });
    const created = await createRes.json();
    const putRes = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ visibleMenus: ['konto', 'checkin'], canEditCharacters: true }),
    });
    assert.equal(putRes.status, 200);
    const updated = await putRes.json();
    assert.deepEqual(updated.visible_menus.sort(), ['checkin', 'konto']);
    assert.equal(updated.can_edit_characters, true);
  } finally {
    server.close();
  }
});

test('PUT /groups/:id rejects editing the protected admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const { rows } = await query("SELECT id FROM groups WHERE key = 'admin'");
    const res = await fetch(`http://localhost:${port}/groups/${rows[0].id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ visibleMenus: [] }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/integration/groups.test.js`
Expected: all 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/groups/repository.js backend/groups/routes.js backend/middleware/authorize.js backend/server.js tests/integration/groups.test.js
git commit -m "feat: add groups CRUD API, admin-only"
```

---

### Task 2: Shared `nav.js` + apply to all 4 authenticated pages

**Files:**
- Create: `frontend/js/nav.js`
- Modify: `frontend/account.html`
- Modify: `frontend/characters.html`
- Modify: `frontend/admin/events.html`
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `GET /account`'s response shape from the groups-foundation plan — `{ group: {key, name}, menus: string[], canEditCharacters, ... }`.
- Produces: `export function renderNavLinks(account, currentPath)` — returns an HTML string of `<a>` tags (no wrapping `<nav>`, no Logout link — callers already have their own Logout link/handler and just inject this into their existing nav container). Task 3's `admin/groups.html` also consumes this.

- [ ] **Step 1: Write `frontend/js/nav.js`**

```javascript
const MENU_LINKS = [
  { key: 'konto', label: 'Konto', href: '/account.html' },
  { key: 'charaktere', label: 'Charaktere', href: '/characters.html' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html' },
  { key: 'events', label: 'Events', href: '/admin/events.html' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html' },
];

export function renderNavLinks(account, currentPath) {
  const links = MENU_LINKS.filter((item) => account.menus.includes(item.key));
  if (account.group.key === 'admin') {
    links.push({ key: 'gruppen', label: 'Gruppen', href: '/admin/groups.html' });
  }
  return links.map(({ href, label }) => {
    const current = href === currentPath ? ' class="current"' : '';
    return `<a href="${href}"${current}>${label}</a>`;
  }).join('');
}
```

(`account.group.key === 'admin'` gates the "Gruppen" link directly — not via `menus` — because group management access is hardcoded to the admin group per Global Constraints, not a configurable menu permission. `href`/`label` values here are fixed constants, not user input, so no escaping is needed on them.)

- [ ] **Step 2: Update `frontend/account.html`**

Replace the existing `<nav>` element:
```html
<nav>
  <a href="/account.html">Konto</a>
  <a href="/characters.html">Charaktere</a>
  <span id="admin-nav-links"></span>
  <a href="#" id="logout-link">Logout</a>
</nav>
```
with:
```html
<nav class="app-nav" id="nav-links"></nav>
```
(Note: the exact current markup may differ slightly in class names from the groups-foundation/UI-theming plans — find the actual `<nav>` block in the file and replace it with the above, preserving the `#logout-link` anchor's `href="#"` and id since the script's logout handler depends on that id — add it back as one of the rendered links, see the script change below.)

In the `<script type="module">` block, add the import:
```javascript
import { renderNavLinks } from '/js/nav.js';
```

Find where the account is fetched (the `try { const account = await api.get('/account'); ... }` block near the bottom of the script) and replace the old nav-gating logic (the `if (account.menus.includes('mitglieder')) { document.getElementById('admin-nav-links').innerHTML = ADMIN_NAV_LINKS; }` block from the groups-foundation plan, and the `ADMIN_NAV_LINKS` constant definition above it — delete both) with:
```javascript
document.getElementById('nav-links').innerHTML =
  renderNavLinks(account, window.location.pathname) + '<a href="#" id="logout-link">Logout</a>';
document.getElementById('logout-link').addEventListener('click', async (evt) => {
  evt.preventDefault();
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});
```
This means the OLD, separate `document.getElementById('logout-link').addEventListener(...)` call that used to run at module load time (attached to a static HTML element) must be REMOVED from wherever it currently sits — the logout link element no longer exists in the static HTML, it's created fresh above, so its listener must be attached right after creating it (as shown), not before.

- [ ] **Step 3: Update `frontend/characters.html`**

Same pattern as Step 2: replace the `<nav>` block with `<nav class="app-nav" id="nav-links"></nav>`, add the `import { renderNavLinks } from '/js/nav.js';` import, delete the `ADMIN_NAV_LINKS` constant and the `if (account.menus.includes('mitglieder')) {...}` block (and the `canEditCharacters = account.canEditCharacters;` line stays — that's unrelated, still needed), replace with the same two-statement pattern (render nav-links innerHTML including a Logout link, then attach the logout click handler to the freshly-created element) as Step 2. Move the existing logout-handling logic's fetch/redirect body into the new handler attachment, don't duplicate it.

- [ ] **Step 4: Update `frontend/admin/events.html`**

This page currently has a static, unconditional two-link sidebar `<nav>` (Events/Check-In) and never fetches `/account` at all. Change:

Replace:
```html
<nav>
  <a href="/admin/events.html" class="current">Events</a>
  <a href="/admin/checkin.html">Check-In</a>
</nav>
```
with:
```html
<nav id="nav-links"></nav>
```

Add the import: `import { renderNavLinks } from '/js/nav.js';`

Find the final `try { await loadEvents(); } catch (err) { ... }` block at the bottom of the script and change it to fetch the account first and render the nav before loading events:
```javascript
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  await loadEvents();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
  else if (err.status === 403) { message.textContent = 'Kein Zugriff – nur für Admins.'; message.className = 'error'; }
}
```
(The `logout-link` element stays exactly where it is in the static HTML — `<div class="sidebar-foot"><a href="#" id="logout-link">Logout</a></div>` is OUTSIDE the `<nav>` element being replaced, in the sidebar footer, and its existing click handler/id are untouched by this change. Only the `<nav>...</nav>` block with the two hardcoded links is replaced.)

- [ ] **Step 5: Update `frontend/admin/checkin.html`**

Identical pattern to Step 4: replace the static two-link `<nav>` with `<nav id="nav-links"></nav>`, add the `renderNavLinks` import, and change the final `try { const events = await api.get('/events'); ... } catch (err) { ... }` block to fetch `/account` first and render the nav before the existing events-loading logic:
```javascript
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  const events = await api.get('/events');
  eventSelect.innerHTML = events.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.event_date)})</option>`).join('');
  if (events.length > 0) {
    await loadParticipants(events[0].id);
  } else {
    message.textContent = 'Keine Events vorhanden.';
  }
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
  else if (err.status === 403) { message.textContent = 'Kein Zugriff – nur für Admins/Check-In-Helfer.'; message.className = 'error'; }
}
```
(Same note as Step 4: `logout-link` in `.sidebar-foot` is untouched.)

- [ ] **Step 6: Verify visually**

Using Claude Browser tools against the running dev stack: log in as `admin@pakyrion.local`/`0000`, confirm ALL FIVE possible links now appear where applicable — `/account.html` and `/characters.html` should show Konto, Charaktere, Mitglieder, Events, Check-In, Gruppen, Logout (Mitglieder will 404 if clicked — expected, see Global Constraints); `/admin/events.html` and `/admin/checkin.html` should show the SAME full set (this is the fix for the original "back to normal area" request — admin now sees Konto/Charaktere links from the admin pages, which it never did before). Confirm the current page's link gets the `current` visual state on all four pages. Confirm no console errors anywhere.

- [ ] **Step 7: Run the unit test suite**

Run: `node --test tests/unit/*.test.js` (no DB needed) — should still be unaffected (this task touches no unit-tested files), confirms nothing else broke.

- [ ] **Step 8: Commit**

```bash
git add frontend/js/nav.js frontend/account.html frontend/characters.html frontend/admin/events.html frontend/admin/checkin.html
git commit -m "feat: replace per-page nav gating with shared menu-driven nav.js"
```

---

### Task 3: `admin/groups.html`

**Files:**
- Create: `frontend/admin/groups.html`
- Modify: `frontend/css/everest-registry.css` (one small additive rule for the checkbox-group layout)

**Interfaces:**
- Consumes: Task 1's `GET/POST/PUT /groups` API, Task 2's `renderNavLinks`.

- [ ] **Step 1: Add the checkbox-group CSS rule**

Add to `frontend/css/everest-registry.css` (the file already has `input[type="checkbox"]{ width:auto; margin-bottom:0; }` from an earlier fix — don't duplicate it, just add this new rule anywhere sensible near the form rules):

```css
.checkbox-group{ display:flex; flex-wrap:wrap; gap:6px 18px; margin-bottom:18px; }
.checkbox-group label{ display:inline-flex; align-items:center; gap:6px; text-transform:none; font-weight:500; font-size:13px; margin-bottom:0; }
```

- [ ] **Step 2: Write `frontend/admin/groups.html`**

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Gruppen verwalten – Pakyrion Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/everest-registry.css">
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-brand">Pakyrion<span>Admin</span></div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot"><a href="#" id="logout-link">Logout</a></div>
  </aside>
  <div class="main"><div class="content">
    <h1>Gruppen verwalten</h1>
    <p class="sub">Lege fest, welche Menüs und Felder jede Gruppe sehen bzw. bearbeiten darf.</p>
    <div class="card">
      <table id="group-list">
        <thead><tr><th>Name</th><th>Schlüssel</th><th>Menüs</th><th>Charaktere bearbeiten</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>

    <div class="card form-pad">
      <h2 id="form-title">Neue Gruppe anlegen</h2>
      <form id="group-form">
        <div class="field-row" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <div>
            <label for="group-name">Name</label>
            <input id="group-name" name="name" type="text" required>
          </div>
          <div>
            <label for="group-key">Schlüssel (nur Kleinbuchstaben, Zahlen, _)</label>
            <input id="group-key" name="key" type="text" required pattern="[a-z0-9_]+">
          </div>
        </div>

        <hr class="hr">
        <h3>Sichtbare Menüs</h3>
        <div class="checkbox-group" id="menu-checkboxes">
          <label><input type="checkbox" value="konto"> Konto</label>
          <label><input type="checkbox" value="charaktere"> Charaktere</label>
          <label><input type="checkbox" value="mitglieder"> Mitglieder</label>
          <label><input type="checkbox" value="events"> Events</label>
          <label><input type="checkbox" value="checkin"> Check-In</label>
        </div>

        <h3>Bearbeitbare Account-Felder (in der Mitgliederverwaltung)</h3>
        <div class="checkbox-group" id="field-checkboxes">
          <label><input type="checkbox" value="address"> Adresse</label>
          <label><input type="checkbox" value="birthdate"> Geburtsdatum</label>
          <label><input type="checkbox" value="phone"> Telefon</label>
          <label><input type="checkbox" value="emergencyContact"> Notfallkontakt</label>
          <label><input type="checkbox" value="medicalNotes"> Gesundheitshinweise</label>
          <label><input type="checkbox" value="group"> Gruppe</label>
        </div>

        <div class="checkbox-group">
          <label><input type="checkbox" id="can-edit-characters"> Darf Charaktere anderer Mitglieder bearbeiten</label>
        </div>

        <button type="submit">Speichern</button>
        <button type="button" id="cancel-edit" style="display:none;" class="btn-ghost">Abbrechen</button>
      </form>
    </div>
    <p id="message"></p>
  </div></div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { escapeHtml } from '/js/formFields.js';
import { renderNavLinks } from '/js/nav.js';

const listBody = document.querySelector('#group-list tbody');
const form = document.getElementById('group-form');
const message = document.getElementById('message');
const formTitle = document.getElementById('form-title');
const nameInput = document.getElementById('group-name');
const keyInput = document.getElementById('group-key');
const cancelButton = document.getElementById('cancel-edit');

let editingGroupId = null;

function getCheckedValues(containerId) {
  return [...document.querySelectorAll(`#${containerId} input:checked`)].map((el) => el.value);
}

function setCheckedValues(containerId, values) {
  document.querySelectorAll(`#${containerId} input`).forEach((el) => {
    el.checked = values.includes(el.value);
  });
}

async function loadGroups() {
  const groups = await api.get('/groups');
  listBody.innerHTML = groups.map((g) => `<tr>
    <td>${escapeHtml(g.name)}</td>
    <td>${escapeHtml(g.key)}</td>
    <td>${g.visible_menus.map((m) => escapeHtml(m)).join(', ') || '–'}</td>
    <td>${g.can_edit_characters ? 'Ja' : 'Nein'}</td>
    <td>${g.is_protected
      ? '<span class="badge badge-inactive">Geschützt</span>'
      : `<button type="button" class="btn-sm btn-ghost" data-edit="${g.id}">Bearbeiten</button>`}</td>
  </tr>`).join('');

  listBody.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const group = groups.find((g) => g.id === button.dataset.edit);
      startEdit(group);
    });
  });
}

function startEdit(group) {
  editingGroupId = group.id;
  formTitle.textContent = `Gruppe bearbeiten: ${group.name}`;
  nameInput.value = group.name;
  keyInput.value = group.key;
  keyInput.disabled = true;
  setCheckedValues('menu-checkboxes', group.visible_menus);
  setCheckedValues('field-checkboxes', group.account_fields);
  document.getElementById('can-edit-characters').checked = group.can_edit_characters;
  form.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
  cancelButton.style.display = '';
}

function resetForm() {
  editingGroupId = null;
  formTitle.textContent = 'Neue Gruppe anlegen';
  form.reset();
  keyInput.disabled = false;
  form.querySelector('button[type="submit"]').textContent = 'Speichern';
  cancelButton.style.display = 'none';
}

cancelButton.addEventListener('click', resetForm);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const payload = {
    name: nameInput.value,
    visibleMenus: getCheckedValues('menu-checkboxes'),
    accountFields: getCheckedValues('field-checkboxes'),
    canEditCharacters: document.getElementById('can-edit-characters').checked,
  };
  try {
    if (editingGroupId) {
      await api.put(`/groups/${editingGroupId}`, payload);
    } else {
      payload.key = keyInput.value;
      await api.post('/groups', payload);
    }
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    resetForm();
    await loadGroups();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});

document.getElementById('logout-link').addEventListener('click', async (evt) => {
  evt.preventDefault();
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});

try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  await loadGroups();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
  else if (err.status === 403) { message.textContent = 'Kein Zugriff – nur für Admins.'; message.className = 'error'; }
}
</script>
</body>
</html>
```

- [ ] **Step 3: Verify visually**

Log in as `admin@pakyrion.local`/`0000`, navigate to `/admin/groups.html` via the new "Gruppen" nav link (confirm it appears — this is the admin-only hardcoded link from Task 2). Confirm all 8 seeded groups list correctly, with `admin`'s row showing "Geschützt" and no edit button. Create a new custom group (e.g. key `test_group`, a couple of menus checked), confirm it appears in the list. Click "Bearbeiten" on the new custom group, change its menus, save, confirm the change persisted. Confirm the key input is disabled while editing. Delete the test group via direct SQL afterward (no delete UI exists — not in scope) to keep the dev DB clean: `docker compose exec db psql -U app -d pakyrion -c "DELETE FROM groups WHERE key = 'test_group';"`.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/groups.html frontend/css/everest-registry.css
git commit -m "feat: add admin groups management page"
```

## Self-Review Notes (for the plan author / controller, not a task)

- Spec coverage: this plan covers the spec's "Gruppen- und NSC-Schema-Verwaltung" backend access-rule paragraph (admin-only, hardcoded) and the `admin/groups.html` frontend section. It deliberately does NOT cover member management or NSC schema — those remain separate plans.
- Known accepted gap (see Global Constraints): the "Mitglieder" nav link will 404 until the very next plan lands. Not a defect to fix here.
- Type/shape consistency: `renderNavLinks(account, currentPath)` (Task 2) is called identically by all 5 pages (Task 2's 4 pages + Task 3's new page) with the exact same two-argument shape — confirmed no divergence across call sites in this plan's own text.
