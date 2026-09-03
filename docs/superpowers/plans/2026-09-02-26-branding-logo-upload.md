# Branding-Logo-Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload a logo image file directly (not just a URL) on the branding settings page, and move that page's field labels below their inputs, matching the participant theme's already-established convention.

**Architecture:** The logo is small enough to store directly on the existing single-row `app_settings` table as `bytea` — no disk volume, no `UPLOADS_DIR` involvement, unlike the larger per-character files. Upload transport, validation shape, and the binary-response mechanism are all reused verbatim from the already-shipped character-files feature (base64-in-JSON, `backend/server.js`'s `isBinary` response flag, the same image MIME allowlist). An uploaded logo takes precedence over the existing `Logo-URL` field when present; the URL field remains as a fallback, with a "Logo entfernen" action to fall back to it.

**Tech Stack:** Node.js stdlib backend, vanilla JS frontend, Postgres, no build step, no new npm dependencies.

**Spec:** none — a small, bounded, user-requested addition inserted ahead of the UI-Verbesserungen initiative's other plans; reuses the file-upload architecture already designed and shipped in `docs/superpowers/specs/2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` (Teil 5) rather than introducing a new one.

## Global Constraints

- No frontend framework, no build step, no new npm dependencies, no multipart parser.
- The LAST task must run the full `npm test` suite as an explicit step.
- **The upload route MUST type-check `dataBase64` before calling `Buffer.from(dataBase64, 'base64')`** (`typeof dataBase64 !== 'string'` → 400). This is not a style preference: the character-files upload route shipped without this check, and a final whole-branch review proved live that an array-like `{"length": N}` value there caused `Buffer.from` to silently ignore the encoding argument and allocate a zero-filled buffer of that length, freezing the whole single-threaded app for over 10 seconds from an 111-byte request. Do not repeat that mistake here.
- The label-below-input change in this plan is scoped to `admin/branding.html` ONLY. The admin theme (`everest-registry.css`) has 51 labels across 6 pages, several JS-generated — retrofitting all of them is real, separate follow-up work, not part of this plan. This plan adds a new, page-scoped CSS pattern rather than changing the shared base `label`/`input` rules every other admin page currently relies on.

---

### Task 1: Backend — logo storage, upload/serve/delete routes

**Files:**
- Create: `db/migrations/023_app_settings_logo.sql`
- Modify: `backend/appSettings/repository.js`
- Modify: `backend/appSettings/routes.js`
- Modify: `tests/integration/appSettings.test.js`

**Interfaces:**
- Produces: `app_settings.logo_data bytea`, `app_settings.logo_mime_type text` (both nullable).
- Produces (repository): `getAppSettings()` now also returns `hasUploadedLogo: boolean`. New `getUploadedLogo()` → `{data: Buffer, mimeType: string} | null`. New `setLogo({data, mimeType})` and `clearLogo()`.
- Produces: `PUT /app-settings/logo` (admin-only) — body `{dataBase64, mimeType}`. `DELETE /app-settings/logo` (admin-only). `GET /app-settings/logo` (public) — raw image bytes or 404.

- [ ] **Step 1: Write the migration**

Create `db/migrations/023_app_settings_logo.sql`:

```sql
ALTER TABLE app_settings ADD COLUMN logo_data bytea;
ALTER TABLE app_settings ADD COLUMN logo_mime_type text;
```

- [ ] **Step 2: Extend the repository**

Read `backend/appSettings/repository.js` first (already shown in full in this project's own recent history — re-read it fresh, since another session may have touched neighboring files). Change `getAppSettings`/`setAppSettings` and add three new exports:

```javascript
import { query } from '../db.js';

export async function getAppSettings() {
  const { rows } = await query('SELECT logo_url, app_title, event_name, quota_mb_per_character, logo_data FROM app_settings LIMIT 1');
  if (rows.length === 0) return { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, hasUploadedLogo: false };
  return {
    logoUrl: rows[0].logo_url,
    appTitle: rows[0].app_title,
    eventName: rows[0].event_name,
    quotaMbPerCharacter: rows[0].quota_mb_per_character,
    hasUploadedLogo: rows[0].logo_data !== null,
  };
}

export async function setAppSettings({ logoUrl, appTitle, eventName, quotaMbPerCharacter }) {
  const { rows } = await query('SELECT id FROM app_settings LIMIT 1');
  if (rows.length === 0) {
    await query(
      'INSERT INTO app_settings (logo_url, app_title, event_name, quota_mb_per_character) VALUES ($1, $2, $3, COALESCE($4, 100))',
      [logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null]
    );
  } else {
    await query(
      'UPDATE app_settings SET logo_url = $2, app_title = $3, event_name = $4, quota_mb_per_character = COALESCE($5, quota_mb_per_character) WHERE id = $1',
      [rows[0].id, logoUrl ?? null, appTitle ?? null, eventName ?? null, quotaMbPerCharacter ?? null]
    );
  }
  return getAppSettings();
}

async function ensureSettingsRow() {
  const { rows } = await query('SELECT id FROM app_settings LIMIT 1');
  if (rows.length > 0) return rows[0].id;
  const { rows: inserted } = await query('INSERT INTO app_settings DEFAULT VALUES RETURNING id');
  return inserted[0].id;
}

export async function getUploadedLogo() {
  const { rows } = await query('SELECT logo_data, logo_mime_type FROM app_settings WHERE logo_data IS NOT NULL LIMIT 1');
  if (rows.length === 0) return null;
  return { data: rows[0].logo_data, mimeType: rows[0].logo_mime_type };
}

export async function setLogo({ data, mimeType }) {
  const id = await ensureSettingsRow();
  await query('UPDATE app_settings SET logo_data = $2, logo_mime_type = $3 WHERE id = $1', [id, data, mimeType]);
}

export async function clearLogo() {
  await query('UPDATE app_settings SET logo_data = NULL, logo_mime_type = NULL');
}
```

(`ensureSettingsRow` matters because `setLogo` can be the very FIRST write to this table — unlike `setAppSettings`, which already handles insert-vs-update itself, a fresh install has zero rows until something creates one. `INSERT INTO app_settings DEFAULT VALUES` relies on every other column already having a sensible default or being nullable — confirmed true: `quota_mb_per_character` defaults to 100, everything else is nullable.)

- [ ] **Step 3: Write the routes**

Read `backend/appSettings/routes.js` first. Add these two imports to the existing import line and these three new routes:

```javascript
import { getAppSettings, setAppSettings, getUploadedLogo, setLogo, clearLogo } from './repository.js';
```

```javascript
const LOGO_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_LOGO_UPLOAD_BODY_BYTES = 3 * 1024 * 1024;

router.put('/app-settings/logo', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req, MAX_LOGO_UPLOAD_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { dataBase64, mimeType } = body;

  if (!LOGO_MIME_ALLOWLIST.includes(mimeType)) {
    return { status: 400, body: { error: `mimeType must be one of: ${LOGO_MIME_ALLOWLIST.join(', ')}` } };
  }
  // Buffer.from silently ignores the 'base64' encoding argument for a
  // non-string (e.g. an array-like {length: N}), allocating a zero-filled
  // buffer of that length instead -- a small request can force a huge,
  // slow allocation this way. Reject anything that isn't a real string
  // before it ever reaches Buffer.from.
  if (typeof dataBase64 !== 'string') {
    return { status: 400, body: { error: 'dataBase64 must be a base64 string' } };
  }

  let data;
  try {
    data = Buffer.from(dataBase64, 'base64');
  } catch {
    return { status: 400, body: { error: 'dataBase64 is not valid base64' } };
  }
  if (data.length === 0) return { status: 400, body: { error: 'dataBase64 is required' } };
  if (data.length > MAX_LOGO_BYTES) {
    return { status: 413, body: { error: `logo exceeds the ${MAX_LOGO_BYTES / (1024 * 1024)}MB limit` } };
  }

  await setLogo({ data, mimeType });
  return { status: 200, body: await getAppSettings() };
})));

router.delete('/app-settings/logo', requireAuth(requireAdminGroup(async () => {
  await clearLogo();
  return { status: 200, body: await getAppSettings() };
})));

router.get('/app-settings/logo', async () => {
  const logo = await getUploadedLogo();
  if (!logo) return { status: 404, body: { error: 'no logo uploaded' } };
  return { status: 200, isBinary: true, body: logo.data, headers: { 'Content-Type': logo.mimeType, 'X-Content-Type-Options': 'nosniff' } };
});
```

(`MAX_LOGO_UPLOAD_BODY_BYTES` at 3MB, not the character-files feature's 30MB, since a logo is capped much lower at 2MB decoded — base64 inflates that to ~2.7MB, and 3MB leaves the same kind of real headroom over the encoded+envelope size that the character-files plan's own arithmetic mistake taught this project to check carefully, rather than sizing the outer cap right up against the inner one.)

- [ ] **Step 4: Write the tests**

Read the existing `tests/integration/appSettings.test.js` first (it already has 4 tests, shown in full below since this is the highest-risk step in this task). **Two existing tests assert the exact response shape of `GET`/`PUT /app-settings` via `assert.deepEqual` — adding `hasUploadedLogo` to that shape (Step 2) will break both unless you update them.** This is not hypothetical: an earlier plan in this project's history added a field to this exact function and broke two pre-existing shape-assertion tests the same way. Update both occurrences:

```javascript
assert.deepEqual(body, { logoUrl: null, appTitle: null, eventName: null, quotaMbPerCharacter: 100, hasUploadedLogo: false });
```
```javascript
assert.deepEqual(getBody, { logoUrl: 'https://example.com/logo.png', appTitle: 'P17 Check-In', eventName: 'P17/2027', quotaMbPerCharacter: 100, hasUploadedLogo: false });
```

Then add these two new tests right before `test.after` (which already does `DELETE FROM app_settings` unconditionally — that already removes any uploaded logo along with the rest of the row, so `test.after` itself needs no changes):

```javascript
test('PUT/GET/DELETE /app-settings/logo round-trips, validates, and clears', async () => {
  await withTestServer(async (port) => {
    const cookie = await makeUserAndSession('admin');
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const beforeRes = await fetch(`http://localhost:${port}/app-settings`);
    assert.equal((await beforeRes.json()).hasUploadedLogo, false);

    const badMimeRes = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: tinyPngBase64, mimeType: 'application/pdf' }),
    });
    assert.equal(badMimeRes.status, 400);

    const nonStringRes = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: { length: 999999 }, mimeType: 'image/png' }),
    });
    assert.equal(nonStringRes.status, 400);

    const uploadRes = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dataBase64: tinyPngBase64, mimeType: 'image/png' }),
    });
    assert.equal(uploadRes.status, 200);
    assert.equal((await uploadRes.json()).hasUploadedLogo, true);

    const getRes = await fetch(`http://localhost:${port}/app-settings/logo`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await getRes.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(tinyPngBase64, 'base64'));

    const deleteRes = await fetch(`http://localhost:${port}/app-settings/logo`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(deleteRes.status, 200);
    assert.equal((await deleteRes.json()).hasUploadedLogo, false);

    const afterDeleteRes = await fetch(`http://localhost:${port}/app-settings/logo`);
    assert.equal(afterDeleteRes.status, 404);
  });
});

test('PUT /app-settings/logo rejects a non-admin group and an unauthenticated request', async () => {
  await withTestServer(async (port) => {
    const memberCookie = await makeUserAndSession('sc');
    const asMember = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ dataBase64: 'x', mimeType: 'image/png' }),
    });
    assert.equal(asMember.status, 403);

    const anonymous = await fetch(`http://localhost:${port}/app-settings/logo`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64: 'x', mimeType: 'image/png' }),
    });
    assert.equal(anonymous.status, 401);
  });
});
```

(`makeUserAndSession(groupKey)` returns the cookie STRING directly, confirmed against the file's own current definition — not an object with a `.cookie` property like some other test files in this project use; the code above already matches this.)

- [ ] **Step 5: Run the tests**

Run: `node --test tests/integration/appSettings.test.js --test-concurrency=1`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/023_app_settings_logo.sql backend/appSettings/repository.js backend/appSettings/routes.js tests/integration/appSettings.test.js
git commit -m "feat: add logo image upload/serve/delete to app-settings"
```

---

### Task 2: Frontend — logo upload UI and page-scoped label-below layout

**Files:**
- Modify: `frontend/admin/branding.html`
- Modify: `frontend/js/branding.js`
- Modify: `frontend/css/everest-registry.css`

**Interfaces:**
- Consumes: `GET/PUT/DELETE /app-settings/logo` (Task 1), `GET /app-settings`'s new `hasUploadedLogo` field.

- [ ] **Step 1: Add a page-scoped label-below CSS pattern**

Read `frontend/css/everest-registry.css` first (already shown in full in this project's own recent history — re-read fresh in case another session has touched it). Add a new, opt-in rule near the existing `label`/`input` rules — do NOT change those existing base rules, which every other admin page still relies on in their current (label-above) order:

```css
.field-below label{ margin-bottom:0; margin-top:6px; order:2; }
.field-below input, .field-below select{ margin-bottom:0; order:1; }
.field-below{ display:flex; flex-direction:column; margin-bottom:18px; }
```

(This uses flexbox `order` rather than reordering the actual HTML, specifically so it stays a drop-in, opt-in wrapper class any future page can adopt without a markup rewrite — apply `.field-below` to a wrapper `<div>` around each existing `<label>`+`<input>` pair, no need to swap their order in the HTML itself.)

- [ ] **Step 2: Apply it to `branding.html`'s 4 fields, and add the upload UI**

Read the current file first (91 lines, shown in full in this project's own recent history — re-read fresh). Replace the form body:

```html
      <form id="branding-form">
        <div class="field-below">
          <label for="app-title">App-Titel</label>
          <input id="app-title" name="appTitle" type="text" placeholder="Pakyrion">
        </div>
        <div class="field-below">
          <label for="event-name">Event-Name</label>
          <input id="event-name" name="eventName" type="text" placeholder="P17/2027">
        </div>
        <div class="field-below">
          <label for="logo-url">Logo-URL</label>
          <input id="logo-url" name="logoUrl" type="url" placeholder="https://example.com/logo.png">
        </div>
        <p class="sub" id="logo-url-note" style="display:none;">Ein hochgeladenes Logo hat Vorrang vor dieser URL.</p>
        <div class="field-below">
          <label for="quota-mb">Speicher-Kontingent pro Charakter (MB)</label>
          <input id="quota-mb" name="quotaMbPerCharacter" type="number" min="1" step="1" placeholder="100">
        </div>
        <button type="submit">Speichern</button>
      </form>
      <hr class="hr">
      <h2>Logo hochladen</h2>
      <img id="logo-preview" alt="Aktuelles Logo" style="max-width:120px;max-height:120px;display:none;">
      <p id="logo-preview-empty" class="sub">Kein Logo hochgeladen.</p>
      <input type="file" id="logo-file" accept="image/jpeg,image/png,image/webp">
      <button type="button" id="logo-upload-btn">Hochladen</button>
      <button type="button" id="logo-remove-btn" style="display:none;">Logo entfernen</button>
```

Add the corresponding JS. In the `<script type="module">` block, add these functions and wire them into `loadSettings()`:

```javascript
const LOGO_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp'];

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function refreshLogoPreview(hasUploadedLogo) {
  const preview = document.getElementById('logo-preview');
  const empty = document.getElementById('logo-preview-empty');
  const removeBtn = document.getElementById('logo-remove-btn');
  const urlNote = document.getElementById('logo-url-note');
  if (hasUploadedLogo) {
    preview.src = `/app-settings/logo?t=${Date.now()}`;
    preview.style.display = '';
    empty.style.display = 'none';
    removeBtn.style.display = '';
    urlNote.style.display = '';
  } else {
    preview.style.display = 'none';
    empty.style.display = '';
    removeBtn.style.display = 'none';
    urlNote.style.display = 'none';
  }
}

document.getElementById('logo-upload-btn').addEventListener('click', async () => {
  message.textContent = '';
  message.className = '';
  const file = document.getElementById('logo-file').files[0];
  if (!file) return;
  if (!LOGO_MIME_ALLOWLIST.includes(file.type)) {
    message.textContent = 'Nicht unterstützter Dateityp.';
    message.className = 'error';
    return;
  }
  try {
    const dataBase64 = await readFileAsBase64(file);
    await api.put('/app-settings/logo', { dataBase64, mimeType: file.type });
    refreshLogoPreview(true);
    await applyBranding();
    message.textContent = 'Logo hochgeladen.';
    message.className = 'success';
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});

document.getElementById('logo-remove-btn').addEventListener('click', async () => {
  message.textContent = '';
  message.className = '';
  try {
    await api.delete('/app-settings/logo');
    refreshLogoPreview(false);
    await applyBranding();
    message.textContent = 'Logo entfernt.';
    message.className = 'success';
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});
```

In `loadSettings()`, add one line at the end to initialize the preview state:

```javascript
  refreshLogoPreview(settings.hasUploadedLogo);
```

(The `?t=${Date.now()}` query string on the preview `<img>` is a deliberate cache-buster ONLY for this admin-facing preview, which needs to visibly update immediately after a re-upload in the same session — `branding.js`'s own logo `<img>` on every OTHER page does not need this, since a stale cached logo for a few minutes on a participant-facing page is a non-issue this app has no existing precedent of worrying about, and adding a cache-buster there would defeat normal browser caching for every page load, forever, for no real benefit.)

- [ ] **Step 3: Update `branding.js` to prefer the uploaded logo**

Read `frontend/js/branding.js` first (already shown in full in this project's own recent history — re-read fresh). Change the logo section:

```javascript
  if (settings.hasUploadedLogo || settings.logoUrl) {
    const seal = document.querySelector('.brand-seal');
    if (seal) {
      const img = document.createElement('img');
      img.src = settings.hasUploadedLogo ? '/app-settings/logo' : settings.logoUrl;
      img.alt = 'Logo';
      seal.replaceChildren(img);
    }
  }
```

- [ ] **Step 4: Manual verification**

Start the dev server, use the Browser tool: log in as admin, navigate to `/admin/branding.html`. Confirm the 4 existing fields now show their label below the input. Confirm "Kein Logo hochgeladen." shows initially. Upload a small PNG/JPEG file, confirm the preview updates immediately, confirm the "Logo entfernen" button appears and the URL-precedence note shows. Navigate to another page (e.g. `/login.html`) and confirm the uploaded logo — not the URL — now renders in `.brand-seal`. Return to branding, click "Logo entfernen", confirm it reverts to showing "Kein Logo hochgeladen." and any previously-set `Logo-URL` value takes over on other pages again. Try uploading a non-image file (e.g. rename a `.txt` to have no extension, or use a PDF) and confirm the client-side type check rejects it before any request is sent. Screenshot the uploaded and empty states.

- [ ] **Step 5: Commit**

```bash
git add frontend/admin/branding.html frontend/js/branding.js frontend/css/everest-registry.css
git commit -m "feat: add logo image upload UI, move branding page labels below fields"
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

- Spec coverage: covers both parts of the user's interjected request — logo image upload (with URL fallback and a "remove" path back to it) and label-below-input for the branding page specifically, not a theme-wide change that was never asked for.
- Deliberately avoided repeating this session's own recently-found Critical bug: the `typeof dataBase64 !== 'string'` guard is present in Task 1's upload route from the start, not discovered later by a review — the plan's own Global Constraints section explains exactly why, citing the specific incident.
- Type/interface consistency: `LOGO_MIME_ALLOWLIST` (`image/jpeg`/`image/png`/`image/webp`) is identical on both the backend route and the frontend's client-side pre-check — no drift between what the server accepts and what the client warns about before even sending.
- `.field-below` is designed as a genuinely reusable, opt-in wrapper (flexbox `order`, not an HTML reorder) specifically so a future decision to extend label-below-input to the rest of the admin theme doesn't require redoing this page's own markup — it only needs the same class applied elsewhere.
