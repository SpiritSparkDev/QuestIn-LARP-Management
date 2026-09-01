# Corporate Identity / Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin configure a logo URL, an app title, and an event name from a settings page, and have every existing page in the app reflect that branding instead of the hardcoded "Pakyrion" title/brand element.

**Architecture:** A new single-row `app_settings` table (same pattern as `smtp_settings`/`nsc_profile_schema`), a public (unauthenticated) `GET /app-settings` route every page can call before a session exists, an admin-only `PUT /app-settings` route, a new admin page to edit the settings, and a shared `frontend/js/branding.js` module that every existing HTML page imports and calls once on load to rewrite its `<title>` and brand element client-side.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, vanilla JS frontend, Postgres, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-qrcode-qol-design.md` (Plan 2)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step.
- `GET /app-settings` must be public — no `requireAuth` — since the login page itself needs branding data before any session exists.
- `PUT /app-settings` is admin-only via `requireAuth(requireAdminGroup(...))`, matching `admin/settings.html`'s existing SMTP-settings pattern exactly.
- Never introduce a top-level `await` in any page's module script for the branding fetch — call `applyBranding()` without awaiting it (matches this project's `account.html` precedent of firing network work last, un-awaited, and specifically avoids the exact class of bug just found and fixed in the OAuth-Provider-Sichtbarkeit branch: a top-level `await` there delayed the login form's submit handler from attaching, opening a window where a submit fell through to a plaintext-password GET request).
- Logo is a URL-only field. No file upload — the app's generic upload infrastructure doesn't exist yet (a separate, unrelated initiative), and depending on it here would be a premature coupling.

---

### Task 1: Backend — `app_settings` table, repository, routes

**Files:**
- Create: `db/migrations/019_app_settings.sql`
- Create: `backend/appSettings/repository.js`
- Create: `backend/appSettings/routes.js`
- Modify: `backend/server.js`
- Create: `tests/integration/appSettings.test.js`

**Interfaces:**
- Produces: `GET /app-settings` — public, no auth. Returns `200 {logoUrl: string|null, appTitle: string|null, eventName: string|null}` (all `null` when no row exists yet).
- Produces: `PUT /app-settings` — admin-only. Body `{logoUrl?, appTitle?, eventName?}`, returns the saved settings in the same shape as GET.
- Produces (repository): `getAppSettings()` → `{logoUrl, appTitle, eventName}`; `setAppSettings({logoUrl, appTitle, eventName})` → same shape (insert-or-update, single row).

- [ ] **Step 1: Write the migration**

Create `db/migrations/019_app_settings.sql`:

```sql
CREATE TABLE app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logo_url text,
  app_title text,
  event_name text
);
```

- [ ] **Step 2: Write the repository**

Create `backend/appSettings/repository.js`. Mirror `backend/smtpSettings/repository.js`'s insert-or-update shape exactly (read `backend/smtpSettings/repository.js` first for the established pattern), but this table has no encrypted field and no separate "for sending" accessor:

```javascript
import { query } from '../db.js';

export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null };
  return { logoUrl: rows[0].logo_url, appTitle: rows[0].app_title, eventName: rows[0].event_name };
}

export async function setAppSettings({ logoUrl, appTitle, eventName }) {
  const { rows } = await query('SELECT id FROM app_settings LIMIT 1');
  if (rows.length === 0) {
    await query(
      'INSERT INTO app_settings (logo_url, app_title, event_name) VALUES ($1, $2, $3)',
      [logoUrl ?? null, appTitle ?? null, eventName ?? null]
    );
  } else {
    await query(
      'UPDATE app_settings SET logo_url = $2, app_title = $3, event_name = $4 WHERE id = $1',
      [rows[0].id, logoUrl ?? null, appTitle ?? null, eventName ?? null]
    );
  }
  return getAppSettings();
}
```

- [ ] **Step 3: Write the routes**

Create `backend/appSettings/routes.js`:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getAppSettings, setAppSettings } from './repository.js';

router.get('/app-settings', async () => {
  const settings = await getAppSettings();
  return { status: 200, body: settings };
});

router.put('/app-settings', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { logoUrl, appTitle, eventName } = body;
  const saved = await setAppSettings({ logoUrl, appTitle, eventName });
  return { status: 200, body: saved };
})));
```

- [ ] **Step 4: Register the route module**

In `backend/server.js`, add one line after the existing `import './smtpSettings/routes.js';` (line 20):

```javascript
import './appSettings/routes.js';
```

- [ ] **Step 5: Write the tests**

Create `tests/integration/appSettings.test.js`. Use the `withTestServer` helper (the established best-practice pattern for every new test file in this project — read `tests/testServer.js` and `tests/integration/oauthProviders.test.js` first for the exact import/setup style):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Branding', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`app-settings-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return `session=${session.token}`;
}

test('GET /app-settings requires no authentication and returns nulls when unset', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { logoUrl: null, appTitle: null, eventName: null });
  });
});

test('PUT /app-settings saves and GET reflects it back, then update overwrites', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');

    const putRes = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ logoUrl: 'https://example.com/logo.png', appTitle: 'P17 Check-In', eventName: 'P17/2027' }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.appTitle, 'P17 Check-In');

    const getRes = await fetch(`http://localhost:${port}/app-settings`);
    const getBody = await getRes.json();
    assert.deepEqual(getBody, { logoUrl: 'https://example.com/logo.png', appTitle: 'P17 Check-In', eventName: 'P17/2027' });

    // Second PUT overwrites the same row rather than inserting a new one.
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ logoUrl: null, appTitle: 'Renamed', eventName: 'P17/2027' }),
    });
    const { rows } = await query('SELECT count(*)::int FROM app_settings');
    assert.equal(rows[0].count, 1);
  });
});

test('PUT /app-settings rejects a non-admin group and an unauthenticated request', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('sc');
    const asMember = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ appTitle: 'Hijacked' }),
    });
    assert.equal(asMember.status, 403);

    const anonymous = await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appTitle: 'Hijacked' }),
    });
    assert.equal(anonymous.status, 401);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'app-settings-%'");
  await query('DELETE FROM app_settings');
  await closePool();
});
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/integration/appSettings.test.js --test-concurrency=1`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/019_app_settings.sql backend/appSettings/repository.js backend/appSettings/routes.js backend/server.js tests/integration/appSettings.test.js
git commit -m "feat: add app_settings table and GET/PUT /app-settings for branding"
```

---

### Task 2: Frontend — `branding.js` module and admin settings page

**Files:**
- Create: `frontend/js/branding.js`
- Create: `frontend/admin/branding.html`
- Modify: `frontend/js/nav.js`

**Interfaces:**
- Consumes: `GET /app-settings`, `PUT /app-settings` from Task 1.
- Produces: `applyBranding()` (exported from `frontend/js/branding.js`) — called by every page in Task 3. Async function, safe to call without awaiting; never throws (swallows fetch/network errors, since branding is cosmetic and must never block a page).

- [ ] **Step 1: Write `branding.js`**

Create `frontend/js/branding.js`:

```javascript
export async function applyBranding() {
  let settings;
  try {
    const res = await fetch('/app-settings');
    if (!res.ok) return;
    settings = await res.json();
  } catch {
    return;
  }

  if (settings.appTitle) document.title = document.title.replace('Pakyrion', settings.appTitle);

  const brandName = document.querySelector('.brand-name, .sidebar-brand');
  if (brandName && settings.appTitle) {
    // .sidebar-brand has a nested <span>Admin</span> that must survive the rewrite.
    const span = brandName.querySelector('span');
    brandName.childNodes[0].textContent = settings.appTitle;
    if (span) brandName.appendChild(span);
  }

  if (settings.logoUrl) {
    const seal = document.querySelector('.brand-seal');
    if (seal) seal.innerHTML = `<img src="${settings.logoUrl}" alt="Logo">`;
  }
}
```

- [ ] **Step 2: Write the admin branding page**

Create `frontend/admin/branding.html`. Model it directly on `frontend/admin/settings.html` (read that file first — same `<head>`, sidebar, nav-link-loading, and logout-link structure), replacing the SMTP form with a branding form:

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Branding – Pakyrion Admin</title>
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
    <h1>Branding</h1>
    <p class="sub">Logo, App-Titel und Event-Name für andere Organisationen anpassen.</p>
    <div class="card form-pad">
      <form id="branding-form">
        <label for="app-title">App-Titel</label>
        <input id="app-title" name="appTitle" type="text" placeholder="Pakyrion">
        <label for="event-name">Event-Name</label>
        <input id="event-name" name="eventName" type="text" placeholder="P17/2027">
        <label for="logo-url">Logo-URL</label>
        <input id="logo-url" name="logoUrl" type="url" placeholder="https://example.com/logo.png">
        <button type="submit">Speichern</button>
      </form>
    </div>
    <p id="message"></p>
  </div></div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { renderNavLinks } from '/js/nav.js';
import { applyBranding } from '/js/branding.js';

applyBranding();

const form = document.getElementById('branding-form');
const message = document.getElementById('message');

async function loadSettings() {
  const settings = await api.get('/app-settings');
  form.elements.appTitle.value = settings.appTitle ?? '';
  form.elements.eventName.value = settings.eventName ?? '';
  form.elements.logoUrl.value = settings.logoUrl ?? '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    await api.put('/app-settings', data);
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    await loadSettings();
    await applyBranding();
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
  await loadSettings();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
  else if (err.status === 403) { message.textContent = 'Kein Zugriff – nur für Admins.'; message.className = 'error'; }
}
</script>
</body>
</html>
```

(Note: `applyBranding()` is called once, un-awaited, at the top of the script for the page's own initial load, and a second time — awaited, inside the submit handler — right after a successful save, so this page reflects its own just-saved branding immediately without a reload.)

- [ ] **Step 3: Add the nav link**

In `frontend/js/nav.js`, inside the `if (account.group.key === 'admin')` block, add one line after the existing `einstellungen` push (matches the exact hardcoded-admin pattern already used for "Gruppen"/"Einstellungen"):

```javascript
    links.push({ key: 'branding', label: 'Branding', href: '/admin/branding.html' });
```

- [ ] **Step 4: Manual verification**

Start the dev server, use the Browser tool: log in as an admin test user, navigate to `/admin/branding.html`, confirm the "Branding" nav link is present and the page loads. Save a logo URL, app title, and event name; confirm the sidebar brand text updates immediately without a reload, and confirm a second load of any other page (e.g. `/account.html`, once Task 3 lands) picks up the same values. Screenshot as evidence.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/branding.js frontend/admin/branding.html frontend/js/nav.js
git commit -m "feat: add branding.js module and admin branding settings page"
```

---

### Task 3: Roll `applyBranding()` out to every existing page

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/login.html`
- Modify: `frontend/register.html`
- Modify: `frontend/reset-password.html`
- Modify: `frontend/set-password.html`
- Modify: `frontend/verify.html`
- Modify: `frontend/account.html`
- Modify: `frontend/characters.html`
- Modify: `frontend/admin/checkin.html`
- Modify: `frontend/admin/events.html`
- Modify: `frontend/admin/groups.html`
- Modify: `frontend/admin/members.html`
- Modify: `frontend/admin/settings.html`

**Interfaces:**
- Consumes: `applyBranding()` from `frontend/js/branding.js` (Task 2).

This is a single mechanical pattern repeated across 13 files, matching the established approach from the Technische-Schulden plan for this project's prior wide-rollout mechanical changes.

- [ ] **Step 1: Apply the pattern to the 12 files that already have `import { api } from '/js/api.js';` as their first script import**

Read each file first to confirm the exact line still matches (this plan was written against the current committed state; if any line has shifted, find the equivalent `import { api } from '/js/api.js';` line instead of trusting the number). Immediately after that import line, insert exactly these two lines in every one of the 12 files below:

```javascript
import { applyBranding } from '/js/branding.js';
applyBranding();
```

Files and the line to insert after (import line number as of this plan's writing):
- `frontend/account.html:46`
- `frontend/characters.html:64`
- `frontend/login.html:37`
- `frontend/register.html:35`
- `frontend/reset-password.html:27`
- `frontend/set-password.html:27`
- `frontend/verify.html:22`
- `frontend/admin/checkin.html:38`
- `frontend/admin/events.html:48`
- `frontend/admin/groups.html:89`
- `frontend/admin/members.html:74`
- `frontend/admin/settings.html:59`

`applyBranding()` is deliberately called without `await` and as the very first statement after the imports — since it is never a top-level `await`, its placement cannot block any later statement in the file regardless of where it sits (unlike the top-level-await bug just fixed in the OAuth-Provider-Sichtbarkeit branch), so this uniform placement is safe for every file including ones with a very different rest-of-script shape.

- [ ] **Step 2: Apply the pattern to `frontend/index.html` (the one file with no existing module script)**

Read the current file first (19 lines, ends with `</div>\n</body>\n</html>`). Add a new script block immediately before `</body>`:

```html
<script type="module">
import { applyBranding } from '/js/branding.js';
applyBranding();
</script>
```

- [ ] **Step 3: Manual verification**

With an app title and logo URL already saved from Task 2's verification step, use the Browser tool to spot-check at least 4 pages spanning both visual themes and both the with-`api.js`-import and index.html cases: `/login.html`, `/account.html` (participant theme), `/admin/events.html` (admin theme), and `/index.html` (the meta-refresh page — confirm the title updates even though the page redirects almost immediately). Confirm the browser tab title and the brand/sidebar-brand text both reflect the saved app title, and the logo image renders in place of the "P" seal where a `.brand-seal` element exists. Screenshot at least one participant-theme and one admin-theme page as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/login.html frontend/register.html frontend/reset-password.html frontend/set-password.html frontend/verify.html frontend/account.html frontend/characters.html frontend/admin/checkin.html frontend/admin/events.html frontend/admin/groups.html frontend/admin/members.html frontend/admin/settings.html
git commit -m "feat: apply branding.js to every existing page"
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
git commit -m "fix: address full test suite failures found in final verification"
```

## Self-Review Notes

- Spec coverage: covers Plan 2 of `2026-09-01-qrcode-qol-design.md` in full — table, public GET, admin-only PUT, admin settings page, and the full-rollout blast radius the spec explicitly calls out and accepts.
- Type/interface consistency: `getAppSettings()`/`setAppSettings()`'s `{logoUrl, appTitle, eventName}` shape is used identically by the route layer, the test file, and `branding.js`'s consumption of the GET response — no naming drift between snake_case DB columns and the camelCase API surface (matches the existing convention every other route module in this app already uses).
- Blast-radius discipline learned from this project's own history (Mitgliederdaten-Felder plan's `register.html`/`seedAdmin.js` misses, the just-completed OAuth plan's top-level-`await` bug): Task 3 explicitly names every one of the 13 touched files rather than relying on a task's own file list being assumed-complete, and Task 3's own Step 3 verification deliberately includes the one structurally different file (`index.html`, no pre-existing script block) rather than assuming the same 2-line pattern trivially generalizes to it.
