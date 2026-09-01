# QR-Code-Erfassung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every event gets a QR-Code identity (`events.code`); a registered participant sees a personal QR code on their account page; check-in staff can scan that code with a webcam on the check-in page to look the participant up and confirm check-in with one click, without typing a name.

**Architecture:** A new nullable `events.code` column, settable via the existing event admin UI. A new shared pure-logic module builds/parses the QR payload string (`{eventCode}-{groupKey}-{userId}`). `account.html` renders the current user's own code as a QR image via the `qrcode-generator` CDN library (encoding only, drawn to a `<canvas>`). `admin/checkin.html` gains a webcam-driven scanner using the `jsQR` CDN library (decoding only) that resolves a scanned code via a new read-only lookup route, then reuses the *existing* `POST /events/:id/checkin` route to actually check someone in — no new check-in logic.

**Tech Stack:** Node.js stdlib backend, vanilla JS frontend, Postgres, no build step. Two new CDN `<script>` dependencies (not npm packages, matching this project's existing Google-Fonts-via-CDN-link precedent): `qrcode-generator` for encoding, `jsQR` for decoding.

**Spec:** `docs/superpowers/specs/2026-09-01-qrcode-qol-design.md` (Plan 3)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies. The two QR libraries load via `<script src="https://cdn.jsdelivr.net/...">` tags, never `npm install`ed.
- The LAST task must run the full `npm test` suite as an explicit step.
- Never call `applyBranding()` (or any other network call) with a blocking top-level `await` in any page's module script — this exact bug class was found and fixed twice already in this initiative (OAuth-Provider-Sichtbarkeit and Corporate-Identity-Branding branches). Every new script block in this plan must attach its `addEventListener`/`form.addEventListener` calls before any `await`.
- The actual check-in write path is the EXISTING `POST /events/:id/checkin` route (`backend/registrations/routes.js`) — this plan must not duplicate or reimplement that logic. The new scan-lookup route is read-only.
- **Spec gap, resolved here**: the spec does not say how an admin actually sets `events.code` — without a UI field for it, the whole feature would be unreachable. Task 3 adds a "Code"-Feld to the existing event admin form, the obvious minimal fix, matching this project's established pattern of catching and closing such gaps during plan-writing rather than shipping a dead feature.
- The QR payload format `{eventCode}-{groupKey}-{userId}` uses `-` as a separator even though `eventCode` (free text, e.g. `P17/2027`) and `userId` (a UUID, which itself contains `-` characters) can both contain hyphens. Parse it positionally, not with a naive `split('-')`: the trailing 36 characters are always the UUID (its `8-4-4-4-12` hyphen positions are fixed), and every real group key (`admin`/`orga`/`plot_orga`/`sl`/`hilfs_sl`/`nsc`/`gsc`/`sc`, see `db/groupDefaults.js`) uses only lowercase letters and underscores — never a hyphen — so slicing off the trailing UUID and then splitting the remainder on its LAST `-` unambiguously separates `eventCode` (which may itself contain `-`/`/`) from `groupKey`. Exact algorithm is given in Task 2.

---

### Task 1: Backend — `events.code`, scan-lookup route

**Files:**
- Create: `db/migrations/020_events_code.sql`
- Modify: `backend/events/repository.js`
- Modify: `backend/events/routes.js`
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Create: `tests/integration/scanLookup.test.js`

**Interfaces:**
- Produces: `events.code` — nullable text column, settable via the existing `PUT /events/:id` (and `POST /events`, for symmetry).
- Produces: `getScanLookup(eventId, userId)` (in `backend/registrations/repository.js`) → `{userId, name, group, status, characters: [{id, name}]} | null` (null when no registration exists for that user+event).
- Produces: `GET /events/:eventId/scan-lookup?code=...` — same auth as the existing participant list (`requireAuth(requireMenu('checkin')(...))`). Parses `code`, resolves it, returns the lookup shape or an error.

- [ ] **Step 1: Write the migration**

Create `db/migrations/020_events_code.sql`:

```sql
ALTER TABLE events ADD COLUMN code text;
```

- [ ] **Step 2: Let `events.code` be created/read/updated**

In `backend/events/repository.js`, read the current file first (it has `SELECT_COLUMNS`, `createEvent`, `getEvent`, `listEvents`, `updateEvent`, `activateEvent`). Make these exact changes:

Change `SELECT_COLUMNS`:
```javascript
const SELECT_COLUMNS = 'id, name, event_date, code, character_form_schema, is_active, created_at';
```

Change `createEvent`:
```javascript
export async function createEvent({ name, eventDate, code, characterFormSchema }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code, character_form_schema)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null, JSON.stringify(characterFormSchema ?? [])]
  );
  return rows[0];
}
```

Change `updateEvent`:
```javascript
export async function updateEvent(id, { name, eventDate, code, characterFormSchema }) {
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = COALESCE($4, code),
       character_form_schema = COALESCE($5, character_form_schema)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      name ?? null,
      eventDate ?? null,
      code ?? null,
      characterFormSchema !== undefined ? JSON.stringify(characterFormSchema) : null,
    ]
  );
  return rows[0] ?? null;
}
```

`getEvent`/`listEvents`/`activateEvent` need no changes — they already `SELECT ${SELECT_COLUMNS}`, so `code` flows through automatically.

In `backend/events/routes.js`, update the two routes that read from the body:

```javascript
router.post('/events', requireAuth(requireMenu('events')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, code, characterFormSchema } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (characterFormSchema !== undefined && !validateSchemaShape(characterFormSchema)) {
    return { status: 400, body: { error: 'characterFormSchema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
  }
  const event = await createEvent({ name, eventDate, code, characterFormSchema });
  return { status: 201, body: event };
})));
```

```javascript
router.put('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { code, characterFormSchema } = body;
  if (characterFormSchema !== undefined && !validateSchemaShape(characterFormSchema)) {
    return { status: 400, body: { error: 'characterFormSchema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
  }
  const event = await updateEvent(params.id, { ...body, code });
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));
```

(`updateEvent(params.id, { ...body, code })` is deliberately redundant-looking — `code` is already in `body` — but it matches the existing spread-then-destructure style of this route unchanged elsewhere in the file; the only real change is that `code` now flows through `COALESCE` in the repository like every other optional field.)

- [ ] **Step 3: Write the scan-lookup repository function**

In `backend/registrations/repository.js`, add this function (place it near `listParticipantsForEvent`, which it deliberately mirrors — read that function first):

```javascript
export async function getScanLookup(eventId, userId) {
  const { rows } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     JOIN groups g ON g.id = u.group_id
     WHERE r.event_id = $1 AND r.user_id = $2`,
    [eventId, userId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const { rows: characters } = await query(
    'SELECT id, name FROM characters WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  return {
    userId: r.user_id,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    group: r.group_key,
    status: r.status,
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
  };
}
```

(`displayName` is already imported at the top of this file — confirm before adding a second import.)

- [ ] **Step 4: Write the route**

In `backend/registrations/routes.js`, add this route (place it near `GET /events/:id/participants`, which it shares its auth gate with):

```javascript
function parseScanCode(code) {
  if (typeof code !== 'string' || code.length < 38) return null;
  const userId = code.slice(-36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  const rest = code.slice(0, -37);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash === -1) return null;
  const eventCode = rest.slice(0, lastDash);
  const groupKey = rest.slice(lastDash + 1);
  if (!eventCode || !groupKey) return null;
  return { eventCode, groupKey, userId };
}

router.get('/events/:eventId/scan-lookup', requireAuth(requireMenu('checkin')(async ({ req, params }) => {
  const code = new URL(req.url, 'http://localhost').searchParams.get('code');
  const parsed = parseScanCode(code);
  if (!parsed) return { status: 400, body: { error: 'invalid or malformed QR code' } };

  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  if (event.code !== parsed.eventCode) {
    return { status: 400, body: { error: 'this code belongs to a different event' } };
  }

  const lookup = await getScanLookup(params.eventId, parsed.userId);
  if (!lookup) return { status: 404, body: { error: 'no registration found for this participant and event' } };
  return { status: 200, body: lookup };
})));
```

Add `getScanLookup` to the existing `import { ... } from './repository.js';` list at the top of the file. (Confirmed against `backend/server.js`: route handlers only ever receive `{ req, params, requestId }` — there is no built-in query-string parsing anywhere in this router, so parsing `req.url` directly via `URL`/`searchParams` as shown above is the correct and only way to read `?code=...`, not a fallback.)

- [ ] **Step 5: Write the tests**

Create `tests/integration/scanLookup.test.js`, using `withTestServer` (read `tests/testServer.js` and `tests/integration/oauthProviders.test.js` for the established pattern):

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

async function makeUser(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Scan', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`scan-lookup-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return rows[0].id;
}

async function makeEvent(code) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, code) VALUES ('Scan Test Event', '2027-01-01', $1) RETURNING id",
    [code]
  );
  return rows[0].id;
}

test('GET .../scan-lookup resolves a valid, well-formed code to name/group/status/characters', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const scUserId = await makeUser('sc');
    const staffUserId = await makeUser('admin');
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [scUserId, eventId]);
    await query(
      "INSERT INTO characters (user_id, event_id, class, name, data) VALUES ($1, $2, 'sc', 'Aldric', '{}')",
      [scUserId, eventId]
    );
    const session = await createSession(staffUserId);
    const cookie = `session=${session.token}`;

    const code = `P17/2027-sc-${scUserId}`;
    const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, scUserId);
    assert.equal(body.group, 'sc');
    assert.equal(body.status, 'registered');
    assert.deepEqual(body.characters.map((c) => c.name), ['Aldric']);
  });
});

test('GET .../scan-lookup rejects a malformed code with 400, without ever querying the DB for it', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const staffUserId = await makeUser('admin');
    const cookie = `session=${(await createSession(staffUserId)).token}`;

    for (const badCode of ['not-a-real-code', 'P17/2027-sc-not-a-uuid', '']) {
      const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=${encodeURIComponent(badCode)}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(res.status, 400, `expected 400 for code: ${JSON.stringify(badCode)}`);
    }
  });
});

test('GET .../scan-lookup rejects a code whose eventCode belongs to a different event', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const otherEventId = await makeEvent('OTHER/2027');
    const scUserId = await makeUser('sc');
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [scUserId, otherEventId]);
    const staffUserId = await makeUser('admin');
    const cookie = `session=${(await createSession(staffUserId)).token}`;

    // A code minted for otherEventId, scanned against eventId's URL.
    const code = `OTHER/2027-sc-${scUserId}`;
    const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 400);
  });
});

test('GET .../scan-lookup returns 404 for a well-formed code with no matching registration', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const staffUserId = await makeUser('admin');
    const cookie = `session=${(await createSession(staffUserId)).token}`;

    const code = `P17/2027-sc-${crypto.randomUUID()}`;
    const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('GET .../scan-lookup rejects a group without checkin menu access', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent('P17/2027');
    const scUserId = await makeUser('sc');
    const cookie = `session=${(await createSession(scUserId)).token}`;

    const res = await fetch(`http://localhost:${port}/events/${eventId}/scan-lookup?code=P17/2027-sc-${scUserId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 403);
  });
});

test.after(async () => {
  await query("DELETE FROM registrations WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'scan-lookup-%')");
  await query("DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'scan-lookup-%')");
  await query("DELETE FROM users WHERE email LIKE 'scan-lookup-%'");
  await query("DELETE FROM events WHERE name = 'Scan Test Event'");
  await closePool();
});
```

(Confirmed against `db/migrations/003_events_and_characters.sql` and `011_character_class_and_nullable_event.sql`: `characters` has `user_id`, `event_id` (nullable, but must be non-null when `class='sc'` per a CHECK constraint), `class` (defaults `'sc'`, so it's included explicitly above for clarity even though it matches the default), `name` (not null), `data` (jsonb, not null, defaults `'{}'`) — the INSERT above satisfies every constraint as written.)

- [ ] **Step 6: Run the tests**

Run: `node --test tests/integration/scanLookup.test.js --test-concurrency=1`
Expected: all PASS. Also run `node --test tests/integration/events.test.js --test-concurrency=1` to confirm the `code` field addition didn't break any existing event test.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/020_events_code.sql backend/events/repository.js backend/events/routes.js backend/registrations/repository.js backend/registrations/routes.js tests/integration/scanLookup.test.js
git commit -m "feat: add events.code and GET /events/:id/scan-lookup for QR check-in"
```

---

### Task 2: Frontend — shared QR payload build/parse module

**Files:**
- Create: `frontend/js/qrCode.js`
- Create: `tests/unit/qrCode.test.js`

**Interfaces:**
- Produces: `buildScanCode({eventCode, groupKey, userId})` → string. `parseScanCode(code)` → `{eventCode, groupKey, userId} | null`.
- Consumed by: Task 4 (`account.html`, `buildScanCode`) and Task 5 (`admin/checkin.html`, `parseScanCode`). Task 1's backend route has its OWN copy of the parse logic (deliberate — this project keeps frontend and backend as separate module graphs with no cross-boundary imports; duplicating ~10 lines of pure logic is preferable to introducing a new sharing mechanism for one function).

- [ ] **Step 1: Write the module**

Create `frontend/js/qrCode.js`:

```javascript
export function buildScanCode({ eventCode, groupKey, userId }) {
  return `${eventCode}-${groupKey}-${userId}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseScanCode(code) {
  if (typeof code !== 'string' || code.length < 38) return null;
  const userId = code.slice(-36);
  if (!UUID_PATTERN.test(userId)) return null;
  const rest = code.slice(0, -37);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash === -1) return null;
  const eventCode = rest.slice(0, lastDash);
  const groupKey = rest.slice(lastDash + 1);
  if (!eventCode || !groupKey) return null;
  return { eventCode, groupKey, userId };
}
```

- [ ] **Step 2: Write the tests**

Create `tests/unit/qrCode.test.js` (mirrors `tests/unit/formFields.test.js`'s plain-import style — no server, no DB):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanCode, parseScanCode } from '../../frontend/js/qrCode.js';

test('buildScanCode joins the three parts with hyphens', () => {
  assert.equal(
    buildScanCode({ eventCode: 'P17/2027', groupKey: 'sc', userId: '11111111-2222-3333-4444-555555555555' }),
    'P17/2027-sc-11111111-2222-3333-4444-555555555555'
  );
});

test('parseScanCode round-trips a code built by buildScanCode', () => {
  const parts = { eventCode: 'P17/2027', groupKey: 'sc', userId: '11111111-2222-3333-4444-555555555555' };
  assert.deepEqual(parseScanCode(buildScanCode(parts)), parts);
});

test('parseScanCode handles an eventCode that itself contains a hyphen', () => {
  const parts = { eventCode: 'Con-2027', groupKey: 'hilfs_sl', userId: '11111111-2222-3333-4444-555555555555' };
  assert.deepEqual(parseScanCode(buildScanCode(parts)), parts);
});

test('parseScanCode rejects non-strings, empty strings, and strings without a valid trailing UUID', () => {
  assert.equal(parseScanCode(null), null);
  assert.equal(parseScanCode(''), null);
  assert.equal(parseScanCode('P17/2027-sc-not-a-uuid'), null);
  assert.equal(parseScanCode('11111111-2222-3333-4444-555555555555'), null); // no eventCode/groupKey prefix at all
});

test('parseScanCode rejects a code with no groupKey segment', () => {
  assert.equal(parseScanCode('P17/2027-11111111-2222-3333-4444-555555555555'), null);
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test tests/unit/qrCode.test.js`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/js/qrCode.js tests/unit/qrCode.test.js
git commit -m "feat: add shared QR payload build/parse module"
```

---

### Task 3: Frontend — event admin form gets a Code field

**Files:**
- Modify: `frontend/admin/events.html`

**Interfaces:**
- Consumes: `code` field from Task 1's `POST /events` / `PUT /events/:id`.

- [ ] **Step 1: Add the input**

Read the current file first (206 lines). Add a "Code" field right after the existing `eventDate` input, before the `<hr class="hr">`:

```html
        <label for="event-date">Datum</label>
        <input id="event-date" name="eventDate" type="date" required>
        <label for="event-code">QR-Code-Kennung <span class="sealed" style="opacity:0.6;">optional, z.B. P17/2027</span></label>
        <input id="event-code" name="code" type="text" placeholder="P17/2027">
        <hr class="hr">
```

(The `.sealed` class is reused purely for its existing small-muted-badge look, the same class `account.html` uses for "Verschlüsselt" labels — it carries no encryption meaning here, just the visual style. If this reuse looks wrong once you see it rendered, use a plain `<span style="opacity:0.6;font-size:12px;">` instead — cosmetic judgment call, not a correctness requirement.)

- [ ] **Step 2: Wire it into the existing load/submit/edit flow**

In `loadEvents()`'s `startEdit`-triggering row template, no change needed (the table doesn't show every field). In `startEdit(eventData)`, add one line alongside the existing `form.elements.eventDate.value = eventData.event_date;`:

```javascript
  form.elements.code.value = eventData.code ?? '';
```

In the submit handler's `payload` object, add one line:

```javascript
  const payload = {
    name: form.elements.name.value,
    eventDate: form.elements.eventDate.value,
    code: form.elements.code.value || null,
    characterFormSchema: collectSchema(),
  };
```

`resetForm()` already calls `form.reset()`, which clears the new input along with the rest of the form — no change needed there.

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: log in as `admin@pakyrion.local`/`0000`, navigate to `/admin/events.html`, create or edit an event with a Code value (e.g. `P17/2027`), save, reload the page, click "Bearbeiten" on that event again, confirm the Code field shows the saved value. Screenshot as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/events.html
git commit -m "feat: add QR-Code field to event admin form"
```

---

### Task 4: Frontend — QR code generation on the account page

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `buildScanCode` from `frontend/js/qrCode.js` (Task 2), `GET /events` (existing, for the active event + its `code`), `GET /registrations` (existing, to check the current user is actually registered for that event).
- Loads: `https://cdn.jsdelivr.net/npm/qrcode-generator@1/qrcode.min.js` via a `<script>` tag (defines a global `qrcode` function — NOT an ES module export, so it cannot be `import`ed; it must be a plain `<script>` tag loaded before the page's own `<script type="module">` block, and referenced as `window.qrcode` or bare `qrcode` from within the module script).

- [ ] **Step 1: Load the CDN library and add the QR section**

Read the current file first (101 lines). Add the CDN script tag in `<head>`, after the existing stylesheet link:

```html
<link rel="stylesheet" href="/css/chronicle-crest.css">
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1/qrcode.min.js"></script>
</head>
```

Add a new section in the body, after the closing `</form>` and before `<p id="message"></p>`:

```html
    </form>
    <div class="card form-pad" id="qr-section" style="display:none;">
      <h2>Mein QR-Code</h2>
      <p class="sub" id="qr-hint"></p>
      <canvas id="qr-canvas"></canvas>
    </div>
    <p id="message"></p>
```

- [ ] **Step 2: Render the QR code**

In the `<script type="module">` block, add this function (place it near `loadAccount`, since it's called from the same place) and the import it needs:

```javascript
import { buildScanCode } from '/js/qrCode.js';
```

```javascript
async function loadQrCode(account) {
  const qrSection = document.getElementById('qr-section');
  const qrHint = document.getElementById('qr-hint');
  try {
    const [events, registrations] = await Promise.all([api.get('/events'), api.get('/registrations')]);
    const activeEvent = events.find((e) => e.is_active);
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
    const registration = registrations.find((r) => r.eventId === activeEvent.id);
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
```

Call it from inside `loadAccount()`, right after the existing `document.getElementById('nav-links').innerHTML = renderNavLinks(...)` line and before the `formControls.forEach((el) => { el.disabled = false; });` line:

```javascript
    await loadQrCode(account);
```

(This is an `await` INSIDE `loadAccount()`, which itself is already called un-awaited at the bottom of the file via the existing `loadAccount();` statement — so this does not introduce a blocking top-level await; `loadAccount` was already the sole async initializer for this page before this change, and its own internal sequencing is unaffected by this plan's global constraint about top-level awaits.)

- [ ] **Step 3: Manual verification**

Using the `sc@pakyrion.local`/`0000` test account (or `admin@pakyrion.local`/`0000` if the SC test account isn't registered for the active event): ensure an event is active (`admin/events.html` → "Aktivieren") and has a `code` set (Task 3), and that the test user is registered for it (register via `characters.html` or however this project's existing registration flow works — check `frontend/characters.html` for the registration UI if unsure). Navigate to `/account.html`, confirm a QR code image renders in a new "Mein QR-Code" section. Also test the "not registered" and "no active event" hint-text paths by using an unregistered test account / temporarily deactivating the event. Screenshot the rendered QR code as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/account.html
git commit -m "feat: render a personal check-in QR code on the account page"
```

---

### Task 5: Frontend — QR scanning on the check-in page

**Files:**
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `parseScanCode` from `frontend/js/qrCode.js` (Task 2), `GET /events/:eventId/scan-lookup?code=...` (Task 1), the EXISTING `POST /events/:id/checkin` (already used by this page's own "Check-In" button — reused as-is, not modified).
- Loads: `https://cdn.jsdelivr.net/npm/jsqr@1/dist/jsQR.js` via a `<script>` tag (defines a global `jsQR` function).

- [ ] **Step 1: Load the CDN library and add the scan UI**

Read the current file first (167 lines, shown in full above in this plan's research — re-read it fresh in case anything shifted). Add the CDN script tag in `<head>`:

```html
<link rel="stylesheet" href="/css/everest-registry.css">
<script src="https://cdn.jsdelivr.net/npm/jsqr@1/dist/jsQR.js"></script>
</head>
```

Add a new section in the body, right after the closing `</select>` for `event-select` and before the existing `<div class="stat-row">`:

```html
    <select id="event-select" aria-label="Event"></select>
    <div class="card form-pad">
      <h2>QR-Scan</h2>
      <label for="scan-mode">Modus</label>
      <select id="scan-mode">
        <option value="off">Aus</option>
        <option value="push">20s-Push-to-See</option>
        <option value="always">Permanent an</option>
      </select>
      <button type="button" id="scan-start" style="display:none;">Scan starten (20s)</button>
      <p id="scan-status" class="sub"></p>
      <video id="scan-video" style="max-width:320px;display:none;" playsinline muted></video>
      <canvas id="scan-canvas" style="display:none;"></canvas>
    </div>
    <dialog id="scan-dialog">
      <h2>Gescannter Teilnehmer</h2>
      <p><strong id="scan-name"></strong></p>
      <p id="scan-group"></p>
      <p id="scan-status-line"></p>
      <p id="scan-characters"></p>
      <p id="scan-warning" class="error" style="display:none;"></p>
      <button type="button" id="scan-confirm">Einchecken</button>
      <button type="button" id="scan-cancel">Abbrechen</button>
    </dialog>
    <div class="stat-row">
```

- [ ] **Step 2: Implement the scan lifecycle**

In the `<script type="module">` block, add the import:

```javascript
import { parseScanCode } from '/js/qrCode.js';
```

Add this block of code (place it after the existing `let canOverride = false;` line, before `function applySearchFilter()`):

```javascript
const scanModeSelect = document.getElementById('scan-mode');
const scanStartButton = document.getElementById('scan-start');
const scanStatus = document.getElementById('scan-status');
const scanVideo = document.getElementById('scan-video');
const scanCanvas = document.getElementById('scan-canvas');
const scanDialog = document.getElementById('scan-dialog');

let scanStream = null;
let scanIntervalId = null;
let scanPushTimeoutId = null;
let scanDialogAutoCloseId = null;
let dialogOpenForEventId = null;

function stopScanning() {
  if (scanIntervalId) { clearInterval(scanIntervalId); scanIntervalId = null; }
  if (scanPushTimeoutId) { clearTimeout(scanPushTimeoutId); scanPushTimeoutId = null; }
  if (scanStream) { scanStream.getTracks().forEach((track) => track.stop()); scanStream = null; }
  scanVideo.style.display = 'none';
  scanVideo.srcObject = null;
}

async function startScanning({ pushMode }) {
  stopScanning();
  scanStatus.textContent = '';
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    scanStatus.textContent = 'Kamera nicht verfügbar oder Zugriff verweigert.';
    return;
  }
  scanVideo.srcObject = scanStream;
  scanVideo.style.display = '';
  await scanVideo.play();
  const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });

  scanIntervalId = setInterval(() => {
    if (scanDialog.open || scanVideo.readyState !== scanVideo.HAVE_ENOUGH_DATA) return;
    scanCanvas.width = scanVideo.videoWidth;
    scanCanvas.height = scanVideo.videoHeight;
    ctx.drawImage(scanVideo, 0, 0, scanCanvas.width, scanCanvas.height);
    const imageData = ctx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    if (result) handleScannedCode(result.data);
  }, 750);

  if (pushMode) {
    scanPushTimeoutId = setTimeout(() => {
      stopScanning();
      scanStatus.textContent = '';
    }, 20000);
  }
}

async function handleScannedCode(rawCode) {
  const parsed = parseScanCode(rawCode);
  const eventId = eventSelect.value;
  if (!parsed || !eventId) {
    scanStatus.textContent = 'QR-Code hat ein ungültiges Format.';
    return;
  }
  try {
    const lookup = await api.get(`/events/${eventId}/scan-lookup?code=${encodeURIComponent(rawCode)}`);
    openScanDialog(eventId, lookup);
  } catch (err) {
    scanStatus.textContent = err.message;
  }
}

function openScanDialog(eventId, lookup) {
  dialogOpenForEventId = eventId;
  document.getElementById('scan-name').textContent = lookup.name;
  document.getElementById('scan-group').textContent = `Kategorie: ${lookup.group}`;
  document.getElementById('scan-status-line').textContent = `Status: ${STATUS_LABELS[lookup.status] ?? lookup.status}`;
  document.getElementById('scan-characters').textContent = lookup.characters.length > 0
    ? `Charaktere: ${lookup.characters.map((c) => c.name).join(', ')}`
    : '';
  const warning = document.getElementById('scan-warning');
  const confirmButton = document.getElementById('scan-confirm');
  if (lookup.status !== 'registered') {
    warning.textContent = 'Bereits eingecheckt oder ausgecheckt.';
    warning.style.display = '';
    confirmButton.disabled = true;
  } else {
    warning.style.display = 'none';
    confirmButton.disabled = false;
  }
  confirmButton.dataset.userId = lookup.userId;
  scanDialog.showModal();
  scanDialogAutoCloseId = setTimeout(() => { if (scanDialog.open) scanDialog.close(); }, 30000);
}

document.getElementById('scan-confirm').addEventListener('click', async (event) => {
  clearTimeout(scanDialogAutoCloseId);
  const userId = event.target.dataset.userId;
  scanDialog.close();
  await transition(dialogOpenForEventId, userId, 'checkin');
});

document.getElementById('scan-cancel').addEventListener('click', () => {
  clearTimeout(scanDialogAutoCloseId);
  scanDialog.close();
});

scanModeSelect.addEventListener('change', () => {
  const mode = scanModeSelect.value;
  localStorage.setItem('qrScanMode', mode);
  stopScanning();
  scanStartButton.style.display = mode === 'push' ? '' : 'none';
  if (mode === 'always') startScanning({ pushMode: false });
});

scanStartButton.addEventListener('click', () => startScanning({ pushMode: true }));
```

- [ ] **Step 3: Restore the saved mode on load and wire cleanup**

Right after the existing `const STATUS_ORDER = ['registered', 'checked_in', 'checked_out'];` line (which is near the top, before any `await`), add:

```javascript
const savedScanMode = localStorage.getItem('qrScanMode') || 'off';
scanModeSelect.value = savedScanMode;
scanStartButton.style.display = savedScanMode === 'push' ? '' : 'none';
```

At the very end of the existing top-level `try { ... } catch { ... }` block (the one that loads `/account` and `/events`), right after `await loadParticipants(events[0].id);`, add:

```javascript
    if (savedScanMode === 'always') startScanning({ pushMode: false });
```

(This sits inside the existing `if (events.length > 0) { ... }` block, after the participant list has loaded — starting the camera immediately on page load only when the user previously chose "Permanent an" for THIS browser, matching the spec's explicit "clientseitig in localStorage gespeichert, kein Server-Sync" requirement.)

Add `window.addEventListener('beforeunload', stopScanning);` right after the `scanStartButton.addEventListener(...)` line from Step 2, so navigating away always releases the camera.

- [ ] **Step 4: Manual verification**

Start the dev server, use the Browser tool: log in as `admin@pakyrion.local`/`0000`, navigate to `/admin/checkin.html`. Since a real webcam isn't available in the automated Browser tool, verify what CAN be verified without one:
- The "QR-Scan" card renders with the mode select and hint text.
- Switching the mode select to "20s-Push-to-See" reveals the "Scan starten (20s)" button; switching to "Aus" hides it.
- `localStorage.getItem('qrScanMode')` reflects the selected mode after a change (check via `javascript_tool`).
- Reloading the page with a saved mode restores that mode in the select (check via `javascript_tool` setting `localStorage` directly, then reloading).
- No console errors from the `jsQR` script tag loading or from the module script's top-level execution.
- Clicking "Scan starten" while camera access is denied/unavailable in this sandboxed browser shows the "Kamera nicht verfügbar oder Zugriff verweigert." message (this exercises the real `getUserMedia` rejection path, since no real camera exists in this environment — a genuine, not simulated, verification of the error-handling branch).

If the Browser tool's environment cannot exercise `getUserMedia` at all (immediate synchronous throw rather than a promise rejection, or no such API present), note this explicitly rather than silently skipping — the actual scan-decode loop (steps inside `startScanning`'s `setInterval`) cannot be verified live without a real camera or a recorded video fixture, which this plan does not provide; state this limitation plainly in your task report rather than claiming full coverage.

- [ ] **Step 5: Commit**

```bash
git add frontend/admin/checkin.html
git commit -m "feat: add webcam QR scanning to the check-in page"
```

---

### Task 6: Full test suite

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

- Spec coverage: covers Plan 3 of `2026-09-01-qrcode-qol-design.md` in full — `events.code`, both CDN libraries, the QR payload format (with an unambiguous parsing algorithm the spec itself left unspecified), generation on the account page, scanning + lookup + reused check-in on the admin page, all 3 scan modes, the 30s auto-close popup, and the 4 named error-handling cases (invalid format, camera unavailable, invalid participant, duplicate check-in warning).
- Spec gap closed: Task 3 (admin Code field) has no equivalent in the spec's own task breakdown — added because the feature is otherwise unreachable, exactly the kind of gap this project's plan self-reviews have caught before (e.g. the Mitgliederdaten-Felder plan's missing `register.html` update).
- Type/interface consistency: `buildScanCode`/`parseScanCode`'s `{eventCode, groupKey, userId}` shape is identical in Task 2's shared module, Task 4's consumption, Task 5's consumption, and Task 1's independently-duplicated backend parser — the field names and the positional-slice algorithm are spelled out identically in both places so they cannot drift silently.
- Blast-radius discipline: Task 1 explicitly touches both `events/repository.js` AND `events/routes.js` for the new `code` field (not just the migration), having learned from this project's own repeated history of "a task's scoped file list missed a real consumer" findings (`register.html`, `seedAdmin.js`, `admin/events.html`'s schema-type dropdown in earlier plans).
- Known limitation, stated plainly rather than glossed over: Task 5's manual verification cannot exercise a real camera/decode loop in this project's automated Browser tooling — the scan-to-popup path's actual visual/interaction correctness will only be provable with a real webcam or a video fixture, which is out of scope for this plan's own verification step. The final whole-branch review should weigh this when deciding how much confidence to place in Task 5's own report.
