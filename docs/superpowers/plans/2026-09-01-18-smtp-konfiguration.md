# SMTP-Konfiguration in der App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins configure SMTP credentials (host/port/user/password/absender) through an in-app settings page instead of only via server-side environment variables, with a test-send button and visible feedback when an invitation's email fails to send.

**Architecture:** A new `smtp_settings` single-row table (same established pattern as `nsc_profile_schema`: `SELECT ... LIMIT 1`, insert-if-absent-else-update in the repository, no DB-level singleton trick). `backend/auth/mailer.js`'s transport-building logic reads DB settings first, falls back to the existing `SMTP_*` environment variables — but only attempts the DB read when `DATABASE_URL` is actually set, so `tests/unit/mailer.test.js` (which deliberately runs with no database at all) keeps working unchanged. Admin-only access follows the same hardcoded `group.key === 'admin'` pattern already used for group management (`admin/groups.html`, `requireAdminGroup`) rather than a new configurable menu permission — this project's established design deliberately keeps a few capabilities admin-only and non-delegatable to avoid a governance paradox, and SMTP credentials are at least as sensitive as group management.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, `nodemailer` (already a dependency), vanilla JS frontend, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` (Teil 3)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step.
- `tests/unit/mailer.test.js` must keep passing WITHOUT a database connection — this is a hard constraint, not a nice-to-have, since it lives in `tests/unit/` specifically because it has no DB dependency today. Any change to `backend/auth/mailer.js` must preserve this.
- SMTP settings access is admin-only via the existing `requireAdminGroup` middleware pattern, not a new `visible_menus` entry — matches the established precedent for `admin/groups.html`.
- The SMTP password is stored encrypted (`encryptField`/`decryptField` from `backend/crypto/fieldCrypto.js`, same as every other sensitive field in this app) and is NEVER returned in plaintext by `GET /admin/settings/smtp` — only a `hasPassword: boolean` flag.

---

### Task 1: SMTP Settings — Migration + Backend

**Files:**
- Create: `db/migrations/018_smtp_settings.sql`
- Create: `backend/smtpSettings/repository.js`
- Create: `backend/smtpSettings/routes.js`
- Modify: `backend/auth/mailer.js`
- Modify: `backend/server.js`

**Interfaces:**
- Produces: `getSmtpSettings()` — returns `{host, port, username, hasPassword, fromAddress}` or `null` if no row exists yet. Public shape, safe to return from an API response (no plaintext password).
- Produces: `getSmtpSettingsForSending()` — returns `{host, port, username, password, fromAddress}` (password DECRYPTED) or `null`. Internal use only, consumed by `backend/auth/mailer.js`.
- Produces: `setSmtpSettings({host, port, username, password, fromAddress})` — `password` optional; when omitted or empty, the existing encrypted password is preserved (COALESCE pattern, same as every other field-update function in this app). Returns the same shape as `getSmtpSettings()`.
- Both exported from `backend/smtpSettings/repository.js`.

- [ ] **Step 1: Write the migration**

Create `db/migrations/018_smtp_settings.sql`:

```sql
CREATE TABLE smtp_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host text,
  port integer,
  username text,
  password_enc bytea,
  from_address text
);
```

(No seed row — the table starts empty, matching `nsc_profile_schema`'s pattern; `backend/auth/mailer.js` falls back to environment variables when no row exists yet, so there is no "must configure before first boot" requirement.)

- [ ] **Step 2: Create the repository**

Create `backend/smtpSettings/repository.js`:

```javascript
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

export async function getSmtpSettings() {
  const { rows } = await query('SELECT host, port, username, password_enc, from_address FROM smtp_settings LIMIT 1');
  if (rows.length === 0) return null;
  return {
    host: rows[0].host,
    port: rows[0].port,
    username: rows[0].username,
    hasPassword: rows[0].password_enc !== null,
    fromAddress: rows[0].from_address,
  };
}

export async function getSmtpSettingsForSending() {
  const { rows } = await query('SELECT host, port, username, password_enc, from_address FROM smtp_settings LIMIT 1');
  if (rows.length === 0) return null;
  return {
    host: rows[0].host,
    port: rows[0].port,
    username: rows[0].username,
    password: decryptField(rows[0].password_enc),
    fromAddress: rows[0].from_address,
  };
}

export async function setSmtpSettings({ host, port, username, password, fromAddress }) {
  const { rows } = await query('SELECT id FROM smtp_settings LIMIT 1');
  const passwordEnc = password ? encryptField(password) : null;
  if (rows.length === 0) {
    await query(
      'INSERT INTO smtp_settings (host, port, username, password_enc, from_address) VALUES ($1, $2, $3, $4, $5)',
      [host ?? null, port ?? null, username ?? null, passwordEnc, fromAddress ?? null]
    );
  } else {
    await query(
      `UPDATE smtp_settings SET host = $2, port = $3, username = $4, password_enc = COALESCE($5, password_enc), from_address = $6 WHERE id = $1`,
      [rows[0].id, host ?? null, port ?? null, username ?? null, passwordEnc, fromAddress ?? null]
    );
  }
  return getSmtpSettings();
}
```

- [ ] **Step 3: Create the routes**

Create `backend/smtpSettings/routes.js`:

```javascript
import nodemailer from 'nodemailer';
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getSmtpSettings, setSmtpSettings } from './repository.js';

router.get('/admin/settings/smtp', requireAuth(requireAdminGroup(async () => {
  const settings = await getSmtpSettings();
  return { status: 200, body: settings ?? { host: null, port: null, username: null, hasPassword: false, fromAddress: null } };
})));

router.put('/admin/settings/smtp', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { host, port, username, password, fromAddress } = body;
  const saved = await setSmtpSettings({ host, port: port ? Number(port) : null, username, password, fromAddress });
  return { status: 200, body: saved };
})));

router.post('/admin/settings/smtp/test', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { host, port, username, password, fromAddress, to } = body;
  if (!host || !to) return { status: 400, body: { error: 'host and to are required' } };
  try {
    const transporter = nodemailer.createTransport({
      host,
      port: Number(port) || 587,
      auth: username ? { user: username, pass: password } : undefined,
    });
    await transporter.sendMail({
      to,
      from: fromAddress || 'no-reply@pakyrion.local',
      subject: 'Pakyrion SMTP-Test',
      text: 'Diese Test-Mail bestätigt, dass deine SMTP-Einstellungen funktionieren.',
    });
    return { status: 200, body: { sent: true } };
  } catch (err) {
    return { status: 502, body: { error: `SMTP-Test fehlgeschlagen: ${err.message}` } };
  }
})));
```

(The test endpoint deliberately builds its own ad-hoc transporter from the request body — NOT from saved settings or `backend/auth/mailer.js` — so an admin can test a value before saving it, catching a typo before it's committed.)

- [ ] **Step 4: Rewrite `backend/auth/mailer.js`**

Read the current file first (55 lines) to confirm it matches what's below before replacing. Replace the entire file:

```javascript
import nodemailer from 'nodemailer';
import { getSmtpSettingsForSending } from '../smtpSettings/repository.js';
import { logger } from '../logger.js';

async function resolveSmtpConfig() {
  let settings = null;
  if (process.env.DATABASE_URL) {
    try {
      settings = await getSmtpSettingsForSending();
    } catch (err) {
      logger.error('failed to read smtp_settings, falling back to environment variables', { error: err.message });
    }
  }
  return {
    host: settings?.host || process.env.SMTP_HOST,
    port: settings?.port || Number(process.env.SMTP_PORT || 587),
    username: settings?.username || process.env.SMTP_USER,
    password: settings?.password || process.env.SMTP_PASS,
    from: settings?.fromAddress || process.env.SMTP_FROM || 'no-reply@pakyrion.local',
  };
}

async function getTransporterAndFrom() {
  const { host, port, username, password, from } = await resolveSmtpConfig();
  const transporter = host
    ? nodemailer.createTransport({
        host,
        port,
        auth: username ? { user: username, pass: password } : undefined,
      })
    : nodemailer.createTransport({ jsonTransport: true });
  return { transporter, from };
}

function baseUrl() {
  return process.env.APP_BASE_URL || 'http://localhost:3000';
}

export async function sendVerificationEmail(to, token) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${baseUrl()}/verify.html?token=${token}`;
  return transporter.sendMail({
    to,
    from,
    subject: 'Bitte bestätige deine E-Mail-Adresse',
    text: `Bitte bestätige deine E-Mail-Adresse: ${url}`,
  });
}

export async function sendPasswordResetEmail(to, token) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${baseUrl()}/reset-password.html?token=${token}`;
  return transporter.sendMail({
    to,
    from,
    subject: 'Passwort zurücksetzen',
    text: `Setze dein Passwort zurück: ${url}`,
  });
}

export async function sendInvitationEmail(to, token) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${baseUrl()}/set-password.html?token=${token}`;
  return transporter.sendMail({
    to,
    from,
    subject: 'Du wurdest zu Pakyrion eingeladen',
    text: `Du wurdest eingeladen. Setze dein Passwort, um loszulegen: ${url}`,
  });
}
```

**Why the `process.env.DATABASE_URL` check matters:** `tests/unit/mailer.test.js` runs with no database connection at all (it never sets `DATABASE_URL`, never calls `runMigrations()`) — that's deliberate, it's a unit test. `backend/db.js`'s connection pool is created lazily on first `query()` call, so without this guard, `resolveSmtpConfig()` would attempt a real Postgres connection the moment any `send*Email` function is called, breaking that test file's whole premise (and either hanging for `connectionTimeoutMillis: 5000` or throwing ECONNREFUSED). Checking `process.env.DATABASE_URL` first — synchronous, no I/O — lets the unit test's DB-less environment skip the DB path entirely and fall straight to the (also-unset) environment variables, reproducing today's exact `jsonTransport` fallback behavior. Every integration test and the real app always DOES set `DATABASE_URL`, so they go through the DB-read path as intended.

- [ ] **Step 5: Register the new route module**

Read `backend/server.js`'s current import list (it statically imports every route module so their `router.get/post/...` calls run at startup). Add the new module alongside the existing ones — find the line importing `./nscSchema/routes.js` (or similar) and add immediately after it:
```javascript
import './smtpSettings/routes.js';
```

- [ ] **Step 6: Run the affected tests**

Run: `node --test tests/unit/mailer.test.js tests/integration/auth-register.test.js tests/integration/auth-password-reset.test.js tests/integration/members.test.js --test-concurrency=1`
Expected: all PASS — `mailer.test.js` in particular must still pass with ZERO database connection attempts (if you see a connection error or a 5-second hang on any of its tests, the `DATABASE_URL` guard in Step 4 is not working correctly).

- [ ] **Step 7: Commit**

```bash
git add db/migrations/018_smtp_settings.sql backend/smtpSettings/repository.js backend/smtpSettings/routes.js backend/auth/mailer.js backend/server.js
git commit -m "feat: add DB-backed SMTP settings, mailer reads them with env-var fallback"
```

---

### Task 2: SMTP Settings — Frontend

**Files:**
- Create: `frontend/admin/settings.html`
- Modify: `frontend/js/nav.js`

**Interfaces:**
- Consumes: `GET/PUT /admin/settings/smtp`, `POST /admin/settings/smtp/test` from Task 1.

- [ ] **Step 1: Add the nav link**

Read `frontend/js/nav.js`'s current content (18 lines). Change:
```javascript
export function renderNavLinks(account, currentPath) {
  const links = MENU_LINKS.filter((item) => account.menus.includes(item.key));
  if (account.group.key === 'admin') {
    links.push({ key: 'gruppen', label: 'Gruppen', href: '/admin/groups.html' });
  }
  return links.map(({ href, label }) => {
```
to:
```javascript
export function renderNavLinks(account, currentPath) {
  const links = MENU_LINKS.filter((item) => account.menus.includes(item.key));
  if (account.group.key === 'admin') {
    links.push({ key: 'gruppen', label: 'Gruppen', href: '/admin/groups.html' });
    links.push({ key: 'einstellungen', label: 'Einstellungen', href: '/admin/settings.html' });
  }
  return links.map(({ href, label }) => {
```

- [ ] **Step 2: Create `frontend/admin/settings.html`**

Follow the structural pattern already established by `frontend/admin/groups.html` (same theme, same nav-links/logout boilerplate, same `try { const account = await api.get('/account'); ... } catch` guard at the bottom):

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Einstellungen – Pakyrion Admin</title>
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
    <h1>Einstellungen</h1>
    <p class="sub">SMTP-Zugangsdaten für den E-Mail-Versand (Registrierung, Passwort-Reset, Einladungen).</p>
    <div class="card form-pad">
      <form id="smtp-form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <div>
            <label for="smtp-host">Host</label>
            <input id="smtp-host" name="host" type="text" placeholder="smtp.example.com">
          </div>
          <div>
            <label for="smtp-port">Port</label>
            <input id="smtp-port" name="port" type="number" placeholder="587">
          </div>
          <div>
            <label for="smtp-username">Benutzername</label>
            <input id="smtp-username" name="username" type="text">
          </div>
          <div>
            <label for="smtp-password">Passwort</label>
            <input id="smtp-password" name="password" type="password" placeholder="Leer lassen, um das bestehende Passwort zu behalten">
          </div>
        </div>
        <label for="smtp-from">Absender-Adresse</label>
        <input id="smtp-from" name="fromAddress" type="email" placeholder="no-reply@pakyrion.local">
        <button type="submit">Speichern</button>
      </form>
    </div>

    <div class="card form-pad">
      <h2>Test-Mail senden</h2>
      <p class="sub">Prüft die Felder oben, ohne sie zu speichern.</p>
      <label for="test-to">Ziel-E-Mail-Adresse</label>
      <input id="test-to" type="email">
      <button type="button" id="send-test">Test-Mail senden</button>
    </div>
    <p id="message"></p>
  </div></div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { renderNavLinks } from '/js/nav.js';

const form = document.getElementById('smtp-form');
const message = document.getElementById('message');
const testToInput = document.getElementById('test-to');

async function loadSettings() {
  const settings = await api.get('/admin/settings/smtp');
  form.elements.host.value = settings.host ?? '';
  form.elements.port.value = settings.port ?? '';
  form.elements.username.value = settings.username ?? '';
  form.elements.fromAddress.value = settings.fromAddress ?? '';
  form.elements.password.placeholder = settings.hasPassword
    ? 'Gesetzt — leer lassen, um es zu behalten'
    : 'Leer lassen, um das bestehende Passwort zu behalten';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    await api.put('/admin/settings/smtp', data);
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    form.elements.password.value = '';
    await loadSettings();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});

document.getElementById('send-test').addEventListener('click', async () => {
  message.textContent = '';
  message.className = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    await api.post('/admin/settings/smtp/test', { ...data, to: testToInput.value });
    message.textContent = 'Test-Mail verschickt.';
    message.className = 'success';
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

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: log in as admin, confirm "Einstellungen" appears in the nav (and does NOT appear for a non-admin account — check by logging in as a different group's test account if one exists, or by reading `renderNavLinks`'s logic). Navigate to `/admin/settings.html`, fill in a host/port and save, confirm "Gespeichert." and that reloading the page shows the saved values. Enter a target address and click "Test-Mail senden" against a deliberately invalid host (e.g. `does-not-exist.invalid`) and confirm a clear error message appears (not a raw stack trace). Screenshot as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/settings.html frontend/js/nav.js
git commit -m "feat: add SMTP settings admin page"
```

---

### Task 3: Sichtbares Fehlschlagen beim Einladen

**Files:**
- Modify: `backend/members/routes.js`
- Modify: `frontend/admin/members.html`
- Modify: `tests/integration/members.test.js`

**Interfaces:**
- Changes: `POST /members/invite`'s 201 response body gains an `emailSent: boolean` field.

- [ ] **Step 1: Update `backend/members/routes.js`**

Read the current file first (as modified by earlier plans in this initiative — the field names in the invite payload changed from `name` to `firstName`/`lastName`/`nickname` in the previous plan, and `emergencyContact` to 3 fields; confirm the invite handler's shape before editing). Find the email-send block:
```javascript
  try {
    await sendInvitationEmail(invitation.email, invitation.token);
  } catch (err) {
    logger.error('failed to send invitation email', { error: err.message });
  }

  return { status: 201, body: { id: invitation.id, email: invitation.email, status: 'invited' } };
```
Change to:
```javascript
  let emailSent = true;
  try {
    await sendInvitationEmail(invitation.email, invitation.token);
  } catch (err) {
    emailSent = false;
    logger.error('failed to send invitation email', { error: err.message });
  }

  return { status: 201, body: { id: invitation.id, email: invitation.email, status: 'invited', emailSent } };
```

- [ ] **Step 2: Update `frontend/admin/members.html`**

Read the current file first (as modified by earlier plans — the invite form now has firstName/lastName/nickname fields). Find the invite form's submit handler:
```javascript
  try {
    await api.post('/members/invite', payload);
    message.textContent = 'Einladung verschickt.';
    message.className = 'success';
    event.target.reset();
    buildFieldInputs(inviteFields);
    await loadMembers();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
```
Change to:
```javascript
  try {
    const result = await api.post('/members/invite', payload);
    if (result.emailSent) {
      message.textContent = 'Einladung verschickt.';
      message.className = 'success';
    } else {
      message.textContent = 'Einladung erstellt, aber der E-Mail-Versand ist fehlgeschlagen. Bitte SMTP-Einstellungen prüfen oder über "Erneut senden" in der Mitgliederliste erneut versuchen.';
      message.className = 'error';
    }
    event.target.reset();
    buildFieldInputs(inviteFields);
    await loadMembers();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
```

- [ ] **Step 3: Add a test for the failure-visibility path**

Read `tests/integration/members.test.js`'s current content first (as modified by earlier plans). Add a new test near the other invite-related tests:

```javascript
test('POST /members/invite reports emailSent: false when SMTP is unreachable, but still creates the invitation', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const email = `invite-mail-fail-${crypto.randomUUID()}@example.com`;

    // Point SMTP at an unreachable host for the duration of this one request —
    // mailer.js's DB-first lookup finds no smtp_settings row in the test DB,
    // so it falls through to these environment variables.
    const originalHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1'; // nothing listens on port 1; connection refused fast
    try {
      const res = await fetch(`http://localhost:${port}/members/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        body: JSON.stringify({ email, firstName: 'Mail', lastName: 'Fail', group: 'sc' }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.emailSent, false);
    } finally {
      if (originalHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = originalHost;
      delete process.env.SMTP_PORT;
    }
  });
});
```

(Read the test file's actual current helper names — `makeUserAndSession`, `withTestServer` — and match them exactly; this plan's earlier tasks in this initiative already converted this file to `withTestServer` and updated `makeUserAndSession`'s signature, confirm both before writing this test.)

- [ ] **Step 4: Run the affected tests**

Run: `node --test tests/integration/members.test.js --test-concurrency=1`
Expected: all PASS, including the new test.

- [ ] **Step 5: Manual verification**

Start the dev server, use the Browser tool: as admin, go to `/admin/members.html`, ensure no SMTP is configured (default state), invite a new member, confirm the message reads the failure-visibility text (not the plain success message) since the dev environment's default `.env` has no real SMTP host configured. Screenshot as evidence.

- [ ] **Step 6: Commit**

```bash
git add backend/members/routes.js frontend/admin/members.html tests/integration/members.test.js
git commit -m "feat: surface invitation email-send failures to the inviting admin"
```

---

### Task 4: Full test suite

**Files:** None (verification-only task).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test in the project passes, including `tests/unit/mailer.test.js` with zero database connection attempts. This is the mandatory final gate.

- [ ] **Step 2: Commit if Step 1 required fixes**

If Step 1 was already green, skip this step. Otherwise:
```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

## Self-Review Notes

- Spec coverage: covers Teil 3 of `2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` in full (settings page, test-mail button, invite-failure visibility).
- Deliberate deviation from the spec's literal wording: the spec said the new "Einstellungen" nav link should be "datengetrieben wie jedes andere Menü" (a normal `visible_menus` entry). This plan instead follows the established `admin/groups.html` precedent (hardcoded `group.key === 'admin'` check) — the same reasoning this codebase already applied to group management (avoiding a governance paradox where a capability could grant itself to more groups) applies equally, arguably more so, to SMTP credentials. This avoids a migration to retroactively grant a new menu key to existing admin rows, and matches a real, already-established pattern in the code rather than inventing a second one.
- Real conflict found and resolved during planning, not left implicit: `backend/auth/mailer.js` becoming DB-aware would have broken `tests/unit/mailer.test.js`'s deliberate no-database design. Resolved with a synchronous `process.env.DATABASE_URL` presence check before any DB access — verified this file never sets that variable, so the unit test's existing behavior is provably unaffected.
- Type/interface consistency: `getSmtpSettingsForSending()`'s shape (`{host, port, username, password, fromAddress}`) is consumed identically by `resolveSmtpConfig()` in Task 1; `emailSent` is produced once (Task 3, backend) and consumed once (Task 3, frontend) with matching field name.
