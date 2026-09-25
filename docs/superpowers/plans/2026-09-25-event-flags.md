# Event-Flags (Sonderrollen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin define arbitrary per-event "flags" (special roles like GSC, VP, Ersthelfer) as a comma-separated list, and let participants pick which of those flags apply to their registration, independent of their SC/NSC role and editable after the fact.

**Architecture:** `events.flags text[]` holds the admin-defined vocabulary for one event; `registrations.flags text[]` holds the subset a participant chose. Both are plain Postgres arrays validated at the repository layer (`resolveFlags`), not a new schema/type system — this is deliberately simpler than the existing `sc_character_schema`-style schema editors because a flag has no shape beyond its name. On the frontend, flags are rendered and collected as a single synthetic `multiselect` field using the SAME generic machinery (`renderAccountFieldInput`/`collectAccountFieldValues`/`otFieldValuesEqual` from `frontend/js/formFields.js`) that already drives the "Weitere Angaben"-OT-fields — no new rendering code needed.

**Tech Stack:** Node.js (no framework, hand-rolled router), PostgreSQL (`pg` driver, native array parameter support), vanilla JS frontend (no build step), `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-09-25-event-flags-design.md`

## Global Constraints

- Flags are plain strings, no icons/colors/descriptions (spec section 3).
- Flags are selectable regardless of `con_role` (spec section 2) — no role gate like the old `is_gsc`/`nscAvailable` bolt-ons had.
- Multiple flags may be selected at once (spec section 2).
- `registrations.is_gsc` is dropped this plan; GSC becomes a plain flag value migrated via `flags = ARRAY['GSC']` (spec section 4).
- Flags are editable after initial registration via the existing `PUT .../ot-fields` endpoint, including its existing orga/admin email notification (spec section 2, 5.2).
- No cleanup of orphaned flag values when an admin removes a flag from an event's list (spec section 3) — validation only rejects NEW writes of unknown flags, existing stored values are left alone.
- Full test suite (`npm test`) must pass as the last step of the last task.

---

## Task 1: Migration + backend event-flags CRUD

**Files:**
- Create: `db/migrations/044_event_flags.sql`
- Modify: `backend/events/repository.js`
- Modify: `backend/events/routes.js`
- Test: `tests/integration/events.test.js`

**Interfaces:**
- Produces: `events.flags text[]` column (default `'{}'`). `registrations.flags text[]` column (default `'{}'`) — created here because it's part of the same migration, but only Task 2 reads/writes it. `createEvent({ name, eventDate, code, capacity, flags })` and `updateEvent(id, { name, eventDate, code, capacity, clearCapacity, flags })` both accept/return `flags` as part of the event row (`SELECT_COLUMNS` includes it). `POST /events`/`PUT /events/:id` accept `body.flags` (array of strings).

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/events.test.js`, right after the existing `test('capacity can be set on create, updated, and cleared back to unlimited', ...)` block (search for that exact string to find the insertion point):

```javascript
test('flags can be set on create, updated, and cleared back to empty', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Flags-Con', eventDate: '2027-09-03', flags: ['GSC', ' VP ', 'GSC', ''] }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    // Trimmed, deduplicated, empty strings dropped, order preserved.
    assert.deepEqual(created.flags, ['GSC', 'VP']);

    const updateRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ flags: ['Ersthelfer'] }),
    });
    const updated = await updateRes.json();
    assert.deepEqual(updated.flags, ['Ersthelfer']);

    // A PUT that omits flags entirely must preserve it (same partial-update
    // contract every other optional field on this route already has).
    const untouchedRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Flags-Con Renamed' }),
    });
    const untouched = await untouchedRes.json();
    assert.deepEqual(untouched.flags, ['Ersthelfer']);

    // An explicit empty array clears it -- distinct from omitting the field.
    const clearRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ flags: [] }),
    });
    const cleared = await clearRes.json();
    assert.deepEqual(cleared.flags, []);
  });
});

test('an event created without flags defaults to an empty array', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Flaglos-Con', eventDate: '2027-09-04' }),
    });
    const created = await res.json();
    assert.deepEqual(created.flags, []);
  });
});

test('creating an event with a non-array flags value is rejected', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Kaputt-Con', eventDate: '2027-09-05', flags: 'GSC' }),
    });
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Ensure the local test database is running, then run:

```bash
docker compose -f docker-compose.dev.yml up -d db-test
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" node --test --test-concurrency=1 tests/integration/events.test.js
```

Expected: the three new tests FAIL — `created.flags` is `undefined` (column doesn't exist yet / repository doesn't return it), and the "non-array flags" test gets `201` instead of `400` (no validation yet).

- [ ] **Step 3: Write the migration**

Create `db/migrations/044_event_flags.sql`:

```sql
-- Admin-definable per-event "flags" (special roles like GSC, VP,
-- Ersthelfer), and the subset of them each registration selects.
-- Generalizes the previous dedicated registrations.is_gsc bolt-on.

ALTER TABLE events ADD COLUMN flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE registrations ADD COLUMN flags text[] NOT NULL DEFAULT '{}';

-- GSC becomes a plain flag value instead of its own column: every event
-- with at least one is_gsc registration gets 'GSC' added to its flag
-- vocabulary, and every such registration gets flags=['GSC'].
UPDATE events e SET flags = ARRAY['GSC']
WHERE EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = e.id AND r.is_gsc = true);

UPDATE registrations SET flags = ARRAY['GSC'] WHERE is_gsc = true;

ALTER TABLE registrations DROP COLUMN is_gsc;
```

- [ ] **Step 4: Implement `normalizeFlags` and wire `flags` into `backend/events/repository.js`**

Replace the full contents of `backend/events/repository.js` with:

```javascript
import { query } from '../db.js';
import { sendEventDeletedEmail, getTransporterAndFrom } from '../auth/mailer.js';
import { logger } from '../logger.js';

const SELECT_COLUMNS = 'id, name, event_date, code, capacity, flags, is_active, created_at';

// Trims, drops empty strings, and deduplicates while preserving first-seen
// order -- the admin-facing comma-separated textfield can easily produce
// stray whitespace or repeats, and this is the one place that cleans it up
// before it ever reaches a registration's validation.
function normalizeFlags(flags) {
  if (!Array.isArray(flags)) return [];
  const seen = new Set();
  const result = [];
  for (const f of flags) {
    if (typeof f !== 'string') continue;
    const trimmed = f.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export async function createEvent({ name, eventDate, code, capacity, flags }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, code, capacity, flags)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [name, eventDate, code ?? null, capacity ?? null, normalizeFlags(flags)]
  );
  return rows[0];
}

export async function getEvent(id) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM events WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listEvents() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM events ORDER BY event_date`
  );
  return rows;
}

export async function updateEvent(id, { name, eventDate, code, capacity, clearCapacity, flags }) {
  // code/capacity are the fields a caller can legitimately want to CLEAR
  // (empty string / "unbegrenzt") rather than just omit -- COALESCE alone
  // can't tell those apart, since both arrive as a falsy value. $6/$7
  // carry that distinction explicitly: only skip the write when the field
  // was genuinely absent from the call. flags doesn't need this: an empty
  // array is not falsy in JS, so `flags !== undefined` alone tells omitted
  // apart from explicitly-cleared.
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       code = CASE WHEN $6 THEN $4 ELSE code END,
       capacity = CASE WHEN $7 THEN $5 ELSE capacity END,
       flags = COALESCE($8, flags)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id, name ?? null, eventDate ?? null, code ?? null, capacity ?? null,
      code !== undefined, capacity !== undefined || Boolean(clearCapacity),
      flags !== undefined ? normalizeFlags(flags) : null,
    ]
  );
  return rows[0] ?? null;
}

// At most one event is ever active: this unconditionally sets every row's
// is_active based on whether it matches id, in one statement, so the
// invariant holds after every call with no separate "deactivate the rest"
// step to keep in sync.
export async function activateEvent(id) {
  const existing = await getEvent(id);
  if (!existing) return null;
  await query('UPDATE events SET is_active = (id = $1)', [id]);
  return getEvent(id);
}

export async function deleteEvent(id, { force = false, notify = false } = {}) {
  const existing = await getEvent(id);
  if (!existing) return false;
  const { rows } = await query('SELECT 1 FROM registrations WHERE event_id = $1 LIMIT 1', [id]);
  if (rows.length > 0 && !force) {
    const err = new Error('Event hat noch Anmeldungen und kann nicht gelöscht werden.');
    err.code = 'EVENT_HAS_REGISTRATIONS';
    throw err;
  }

  let participantEmails = [];
  if (rows.length > 0 && notify) {
    const { rows: emailRows } = await query(
      'SELECT u.email FROM users u JOIN registrations r ON r.user_id = u.id WHERE r.event_id = $1',
      [id]
    );
    participantEmails = emailRows.map((r) => r.email);
  }

  // events.registrations has ON DELETE CASCADE, so removing the event row
  // also removes its registrations (and their payments) in one statement.
  await query('DELETE FROM events WHERE id = $1', [id]);

  if (participantEmails.length > 0) {
    const transport = await getTransporterAndFrom();
    for (const to of participantEmails) {
      try {
        await sendEventDeletedEmail(to, { eventName: existing.name }, transport);
      } catch (err) {
        logger.error('failed to send event-deleted notification', { error: err.message, to, eventId: id });
      }
    }
  }

  return true;
}
```

- [ ] **Step 5: Validate `flags` in `backend/events/routes.js`**

In `backend/events/routes.js`, in the `router.post('/events', ...)` handler, change:

```javascript
  const { name, eventDate, code, capacity } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (capacity !== undefined && capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  const event = await createEvent({ name, eventDate, code, capacity });
```

to:

```javascript
  const { name, eventDate, code, capacity, flags } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (capacity !== undefined && capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  if (flags !== undefined && (!Array.isArray(flags) || flags.some((f) => typeof f !== 'string'))) {
    return { status: 400, body: { error: 'flags must be an array of strings' } };
  }
  const event = await createEvent({ name, eventDate, code, capacity, flags });
```

And in `router.put('/events/:id', ...)`, change:

```javascript
  if (body.capacity !== undefined && body.capacity !== null && (!Number.isInteger(body.capacity) || body.capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  const before = await getEvent(params.id);
```

to:

```javascript
  if (body.capacity !== undefined && body.capacity !== null && (!Number.isInteger(body.capacity) || body.capacity < 1)) {
    return { status: 400, body: { error: 'capacity must be a positive integer or null' } };
  }
  if (body.flags !== undefined && (!Array.isArray(body.flags) || body.flags.some((f) => typeof f !== 'string'))) {
    return { status: 400, body: { error: 'flags must be an array of strings' } };
  }
  const before = await getEvent(params.id);
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" node --test --test-concurrency=1 tests/integration/events.test.js
```

Expected: PASS, all tests in the file green (including the pre-existing ones — nothing else in this file should have changed behavior).

- [ ] **Step 7: Commit**

```bash
git add db/migrations/044_event_flags.sql backend/events/repository.js backend/events/routes.js tests/integration/events.test.js
git commit -m "feat: add admin-definable per-event flags"
```

---

## Task 2: Registration flags (register / con-role / listing endpoints)

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Test: `tests/integration/registrations.test.js`

**Interfaces:**
- Consumes: `getEvent(eventId)` from Task 1 now returns `.flags` (string array).
- Produces: `resolveFlags(eventFlags, flags)` (module-private) — validates and normalizes. `registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, flags, otFields, requestingUser)` — `isGsc` parameter replaced by `flags` (array), no more role gate. `setConRole(eventId, userId, conRole, characterId, nscAvailable, nscCharacterId, flags, requestingUser)` — same replacement. Every registration-shaped object this file returns (`listParticipantsForEvent`, `getScanLookup`, `listRegistrationsForUser`, and the two functions above) carries `flags`/`isGsc` → `flags` (array, never the old boolean). New error code `INVALID_FLAG` (400).

- [ ] **Step 1: Write the failing tests**

In `tests/integration/registrations.test.js`, add this helper right after the existing `makeEvent`/`makeEventNamed` functions (search for `async function makeEventNamed(name, eventDate) {` to find the spot, insert after its closing `}`):

```javascript
async function makeEventWithFlags(flags) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active, flags) VALUES ('Reg Test Con', '2027-08-01', true, $1) RETURNING id",
    [flags]
  );
  return rows[0].id;
}
```

Then replace the existing `test('registering with con_role sc and isGsc true stores the flag but keeps con_role "sc"', ...)` and `test('isGsc is rejected for any con_role other than sc', ...)` blocks (search for `test('registering with con_role sc and isGsc true` to find the start, and the matching `});` after `test('isGsc is rejected for any con_role other than sc'` to find the end) with:

```javascript
test('registering with a flag defined on the event stores it', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEventWithFlags(['GSC', 'VP']);
    const characterId = await makeCharacter(port, cookie, 'sc', 'Aldric');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId, flags: ['GSC'] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.con_role, 'sc');
    assert.deepEqual(body.flags, ['GSC']);
  });
});

test('registering with con_role nsc and a flag defined on the event stores it too (flags are role-independent)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEventWithFlags(['Ersthelfer']);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', flags: ['Ersthelfer'] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.con_role, 'nsc');
    assert.deepEqual(body.flags, ['Ersthelfer']);
  });
});

test('registering with multiple flags stores all of them, normalized to the event\'s flag order', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEventWithFlags(['GSC', 'VP', 'Ersthelfer']);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', flags: ['Ersthelfer', 'GSC'] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.flags, ['GSC', 'Ersthelfer']);
  });
});

test('registering with a flag not defined on the event is rejected', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEventWithFlags(['GSC']);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', flags: ['Nicht-Definiert'] }),
    });
    assert.equal(res.status, 400);
  });
});

test('registering with no flags on an event that has none defaults to an empty array', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.flags, []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" node --test --test-concurrency=1 tests/integration/registrations.test.js
```

Expected: the new tests FAIL (server still expects `isGsc`, `body.flags` comes back `undefined`; the unknown-flag test gets `201` since nothing validates it yet).

- [ ] **Step 3: Replace `resolveIsGsc` with `resolveFlags` and thread `flags` through `backend/registrations/repository.js`**

In `backend/registrations/repository.js`, replace the `resolveIsGsc` function:

```javascript
// Validates the "sc played as GSC" bolt-on: only meaningful when con_role='sc',
// same shape as resolveNscAvailability's role gate. Returns the isGsc to store.
function resolveIsGsc(conRole, isGsc) {
  const flagged = Boolean(isGsc);
  if (conRole !== 'sc' && flagged) {
    const err = new Error('isGsc ist nur zusammen mit con_role "sc" erlaubt.');
    err.code = 'INVALID_GSC_FLAG';
    throw err;
  }
  return flagged;
}
```

with:

```javascript
// Validates the requested flags against the event's defined vocabulary --
// role-independent (unlike resolveNscAvailability/the old resolveIsGsc, no
// con_role gate: a flag like "Ersthelfer" applies regardless of SC/NSC/etc).
// Returns the flags to store, deduplicated and normalized to eventFlags'
// order (so display is consistent regardless of the order they were sent in).
function resolveFlags(eventFlags, flags) {
  const requested = Array.isArray(flags) ? flags : [];
  const invalid = requested.filter((f) => !eventFlags.includes(f));
  if (invalid.length > 0) {
    const err = new Error(`Unbekannte Flags: ${invalid.join(', ')}`);
    err.code = 'INVALID_FLAG';
    throw err;
  }
  return eventFlags.filter((f) => requested.includes(f));
}
```

Then update `registerForEvent`. Change its signature and the two lines that resolve/use the bolt-on:

```javascript
export async function registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, isGsc, otFields, requestingUser) {
```
→
```javascript
export async function registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, flags, otFields, requestingUser) {
```

```javascript
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);
  const resolvedIsGsc = resolveIsGsc(conRole, isGsc);
```
→
```javascript
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);
  const resolvedFlags = resolveFlags(event.flags, flags);
```

```javascript
      const { rows } = await client.query(
        `INSERT INTO registrations (user_id, event_id, con_role, character_id, nsc_available, nsc_character_id, is_gsc, registration_data_enc, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, is_gsc, checked_in_at, checked_out_at`,
        [userId, eventId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, resolvedIsGsc, encryptFieldBlob(data), status]
      );
```
→
```javascript
      const { rows } = await client.query(
        `INSERT INTO registrations (user_id, event_id, con_role, character_id, nsc_available, nsc_character_id, flags, registration_data_enc, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, flags, checked_in_at, checked_out_at`,
        [userId, eventId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, resolvedFlags, encryptFieldBlob(data), status]
      );
```

Then update `setConRole` the same way. Change:

```javascript
export async function setConRole(eventId, userId, conRole, characterId, nscAvailable, nscCharacterId, isGsc, requestingUser) {
```
→
```javascript
export async function setConRole(eventId, userId, conRole, characterId, nscAvailable, nscCharacterId, flags, requestingUser) {
```

```javascript
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);
  const resolvedIsGsc = resolveIsGsc(conRole, isGsc);

  const { rows } = await query(
    `UPDATE registrations SET con_role = $3, character_id = $4, nsc_available = $5, nsc_character_id = $6, is_gsc = $7
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, is_gsc, checked_in_at, checked_out_at`,
    [eventId, userId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, resolvedIsGsc]
  );
```
→
```javascript
  // setConRole never loaded the event before (registerForEvent does, for
  // capacity/is_active) -- flags needs the event's flag vocabulary to
  // validate against. Falls back to [] if the event is somehow gone by now
  // (the FK on registrations.event_id makes that practically unreachable,
  // but resolveFlags rejecting any non-empty request in that case is the
  // safe default either way).
  const event = await getEvent(eventId);
  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);
  const resolvedFlags = resolveFlags(event?.flags ?? [], flags);

  const { rows } = await query(
    `UPDATE registrations SET con_role = $3, character_id = $4, nsc_available = $5, nsc_character_id = $6, flags = $7
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, flags, checked_in_at, checked_out_at`,
    [eventId, userId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, resolvedFlags]
  );
```

Now update the three read functions. In `listParticipantsForEvent`, change:

```javascript
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.nsc_available, r.nsc_character_id, r.is_gsc, r.checked_in_at, r.checked_out_at,
```
→
```javascript
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.nsc_available, r.nsc_character_id, r.flags, r.checked_in_at, r.checked_out_at,
```

and:

```javascript
      conRole: r.con_role,
      nscAvailable: r.nsc_available,
      nscCharacterId: r.nsc_character_id,
      isGsc: r.is_gsc,
      checkedInAt: r.checked_in_at,
```
→
```javascript
      conRole: r.con_role,
      nscAvailable: r.nsc_available,
      nscCharacterId: r.nsc_character_id,
      flags: r.flags,
      checkedInAt: r.checked_in_at,
```

In `getScanLookup`, change:

```javascript
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status, r.con_role, r.nsc_available, r.is_gsc
```
→
```javascript
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status, r.con_role, r.nsc_available, r.flags
```

and:

```javascript
    status: r.status,
    conRole: r.con_role,
    nscAvailable: r.nsc_available,
    isGsc: r.is_gsc,
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
```
→
```javascript
    status: r.status,
    conRole: r.con_role,
    nscAvailable: r.nsc_available,
    flags: r.flags,
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
```

In `listRegistrationsForUser`, change:

```javascript
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.nsc_available, r.nsc_character_id, r.is_gsc, r.checked_in_at, r.checked_out_at,
```
→
```javascript
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.nsc_available, r.nsc_character_id, r.flags, r.checked_in_at, r.checked_out_at,
```

and:

```javascript
    nscAvailable: r.nsc_available,
    nscCharacterId: r.nsc_character_id,
    nscCharacterName: r.nsc_character_name,
    isGsc: r.is_gsc,
    checkedInAt: r.checked_in_at,
```
→
```javascript
    nscAvailable: r.nsc_available,
    nscCharacterId: r.nsc_character_id,
    nscCharacterName: r.nsc_character_name,
    flags: r.flags,
    checkedInAt: r.checked_in_at,
```

- [ ] **Step 4: Wire `flags` through `backend/registrations/routes.js`**

In `router.post('/events/:id/register', ...)`, change:

```javascript
    const registration = await registerForEvent(user.id, params.id, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, body.isGsc, body.otFields, user);
```
→
```javascript
    const registration = await registerForEvent(user.id, params.id, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, body.flags, body.otFields, user);
```

and in the same handler's `catch` block, change:

```javascript
    if (err.code === 'INVALID_GSC_FLAG') return { status: 400, body: { error: err.message } };
```
→
```javascript
    if (err.code === 'INVALID_FLAG') return { status: 400, body: { error: err.message } };
```

In `router.put('/events/:id/registrations/:userId/con-role', ...)`, change:

```javascript
    const registration = await setConRole(params.id, params.userId, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, body.isGsc, user);
```
→
```javascript
    const registration = await setConRole(params.id, params.userId, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, body.flags, user);
```

and in the same handler's `catch` block, change:

```javascript
    if (err.code === 'INVALID_GSC_FLAG') return { status: 400, body: { error: err.message } };
```
→
```javascript
    if (err.code === 'INVALID_FLAG') return { status: 400, body: { error: err.message } };
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" node --test --test-concurrency=1 tests/integration/registrations.test.js
```

Expected: PASS, every test in the file green (this file has ~65 tests total by now — all must stay green, not just the new ones).

- [ ] **Step 6: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js tests/integration/registrations.test.js
git commit -m "feat: make registration flags role-independent, replacing the sc-only GSC bolt-on"
```

---

## Task 3: Flags editable via the existing OT-fields endpoint

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Test: `tests/integration/registrations.test.js`

**Interfaces:**
- Consumes: `resolveFlags(eventFlags, flags)` and `getEvent` from Task 2.
- Produces: `updateRegistrationOtFields(eventId, userId, otFields, flags)` — new 4th parameter; when `undefined`, flags are left untouched; the returned object now includes `flags`. `STRUCTURAL_REGISTRATION_KEYS` in routes.js includes `'flags'` (always visible to staff, no `accountFields` gate — same treatment as `conRole`/`characterId`).

- [ ] **Step 1: Write the failing tests**

In `tests/integration/registrations.test.js`, add after the existing `test('PUT .../ot-fields updates fields for the registration owner and does not touch con_role/character', ...)` block (search for that string, insert after its closing `});`):

```javascript
test('PUT .../ot-fields updates flags for an event that defines them', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEventWithFlags(['VP', 'Ersthelfer']);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ flags: ['VP'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.flags, ['VP']);
  });
});

test('PUT .../ot-fields omitting flags leaves the existing selection unchanged', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEventWithFlags(['VP']);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', flags: ['VP'] }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conTage: '2' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.flags, ['VP']);
  });
});

test('PUT .../ot-fields with a flag not defined on the event is rejected', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEventWithFlags(['VP']);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ flags: ['Unbekannt'] }),
    });
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" node --test --test-concurrency=1 tests/integration/registrations.test.js
```

Expected: the three new tests FAIL — `body.flags` comes back `undefined` (the endpoint doesn't read/return it yet), and the unknown-flag test gets `200` instead of `400`.

- [ ] **Step 3: Implement in `backend/registrations/repository.js`**

Replace `updateRegistrationOtFields`:

```javascript
export async function updateRegistrationOtFields(eventId, userId, otFields) {
  const schema = await getRegistrationFieldSchema();
  const { rows: currentRows } = await query(
    'SELECT registration_data_enc FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (currentRows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  const nextData = decryptFieldBlob(currentRows[0].registration_data_enc);
  for (const field of schema) {
    if (otFields[field.key] !== undefined) nextData[field.key] = otFields[field.key];
  }

  const { rows } = await query(
    `UPDATE registrations SET registration_data_enc = $3
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at, registration_data_enc`,
    [eventId, userId, encryptFieldBlob(nextData)]
  );
  const r = rows[0];
  return {
    userId: r.user_id,
    eventId: r.event_id,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    ...decryptFieldBlob(r.registration_data_enc),
  };
}
```

with:

```javascript
export async function updateRegistrationOtFields(eventId, userId, otFields, flags) {
  const schema = await getRegistrationFieldSchema();
  const { rows: currentRows } = await query(
    'SELECT registration_data_enc, flags FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (currentRows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  const nextData = decryptFieldBlob(currentRows[0].registration_data_enc);
  for (const field of schema) {
    if (otFields[field.key] !== undefined) nextData[field.key] = otFields[field.key];
  }

  // Flags aren't part of the OT-schema blob above (they're event-scoped,
  // not a global schema field) -- only touched when the caller explicitly
  // sent them, same "only what's sent" contract as the schema fields loop.
  let nextFlags = currentRows[0].flags;
  if (flags !== undefined) {
    const event = await getEvent(eventId);
    nextFlags = resolveFlags(event?.flags ?? [], flags);
  }

  const { rows } = await query(
    `UPDATE registrations SET registration_data_enc = $3, flags = $4
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, flags, checked_in_at, checked_out_at, registration_data_enc`,
    [eventId, userId, encryptFieldBlob(nextData), nextFlags]
  );
  const r = rows[0];
  return {
    userId: r.user_id,
    eventId: r.event_id,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    flags: r.flags,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    ...decryptFieldBlob(r.registration_data_enc),
  };
}
```

- [ ] **Step 4: Wire it into `backend/registrations/routes.js`**

Change the `STRUCTURAL_REGISTRATION_KEYS` constant:

```javascript
const STRUCTURAL_REGISTRATION_KEYS = ['userId', 'eventId', 'status', 'conRole', 'characterId', 'checkedInAt', 'checkedOutAt'];
```
→
```javascript
const STRUCTURAL_REGISTRATION_KEYS = ['userId', 'eventId', 'status', 'conRole', 'characterId', 'flags', 'checkedInAt', 'checkedOutAt'];
```

And in the `router.put('/events/:id/registrations/:userId/ot-fields', ...)` handler, change:

```javascript
    registration = await updateRegistrationOtFields(params.id, params.userId, body);
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    throw err;
  }
```
→
```javascript
    registration = await updateRegistrationOtFields(params.id, params.userId, body, body.flags);
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_FLAG') return { status: 400, body: { error: err.message } };
    throw err;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" node --test --test-concurrency=1 tests/integration/registrations.test.js
```

Expected: PASS, whole file green.

- [ ] **Step 6: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js tests/integration/registrations.test.js
git commit -m "feat: make registration flags editable via the existing OT-fields endpoint"
```

---

## Task 4: Admin event form — flags textfield

**Files:**
- Modify: `frontend/admin/events.html`

**Interfaces:**
- Consumes: `POST /events`/`PUT /events/:id` accept/return `flags` (array of strings) from Task 1.
- Produces: nothing further downstream depends on this file's internals — it's a leaf UI.

- [ ] **Step 1: Add the field to the form**

In `frontend/admin/events.html`, in the `<form id="event-form">`, change:

```html
        <label for="event-capacity">Max. Teilnehmerzahl <span style="opacity:0.6;font-size:12px;">optional, leer = unbegrenzt</span></label>
        <input id="event-capacity" name="capacity" type="number" min="1" placeholder="unbegrenzt">
        <button type="submit">Speichern</button>
```

to:

```html
        <label for="event-capacity">Max. Teilnehmerzahl <span style="opacity:0.6;font-size:12px;">optional, leer = unbegrenzt</span></label>
        <input id="event-capacity" name="capacity" type="number" min="1" placeholder="unbegrenzt">
        <label for="event-flags">Sonderrollen <span style="opacity:0.6;font-size:12px;">optional, Komma-getrennt, z.B. GSC, VP, Ersthelfer</span></label>
        <input id="event-flags" name="flags" type="text" placeholder="GSC, VP, Ersthelfer">
        <button type="submit">Speichern</button>
```

- [ ] **Step 2: Populate it on edit, and send it on submit**

In the `<script type="module">` block, change `startEdit`:

```javascript
function startEdit(eventData) {
  editingEventId = eventData.id;
  formTitle.textContent = `Event bearbeiten: ${eventData.name}`;
  form.elements.name.value = eventData.name;
  form.elements.eventDate.value = eventData.event_date;
  form.elements.code.value = eventData.code ?? '';
  form.elements.capacity.value = eventData.capacity ?? '';
  form.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
}
```

to:

```javascript
function startEdit(eventData) {
  editingEventId = eventData.id;
  formTitle.textContent = `Event bearbeiten: ${eventData.name}`;
  form.elements.name.value = eventData.name;
  form.elements.eventDate.value = eventData.event_date;
  form.elements.code.value = eventData.code ?? '';
  form.elements.capacity.value = eventData.capacity ?? '';
  form.elements.flags.value = (eventData.flags ?? []).join(', ');
  form.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
}
```

And change the submit handler:

```javascript
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const capacityValue = form.elements.capacity.value;
  const payload = {
    name: form.elements.name.value,
    eventDate: form.elements.eventDate.value,
    code: form.elements.code.value || null,
    capacity: capacityValue ? Number(capacityValue) : null,
    clearCapacity: true,
  };
```

to:

```javascript
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const capacityValue = form.elements.capacity.value;
  const payload = {
    name: form.elements.name.value,
    eventDate: form.elements.eventDate.value,
    code: form.elements.code.value || null,
    capacity: capacityValue ? Number(capacityValue) : null,
    clearCapacity: true,
    flags: form.elements.flags.value.split(',').map((f) => f.trim()).filter(Boolean),
  };
```

`resetForm()` already calls `form.reset()`, which clears the new text input along with the others — no change needed there.

- [ ] **Step 2: Manually verify in the browser**

This file has no automated tests (no test infrastructure exists for this project's inline admin-page scripts — every other admin page in this codebase is verified the same way). Start the dev stack and check by hand:

```bash
docker compose -f docker-compose.dev.yml up -d db app
```

Then in a browser at `http://localhost:3000/admin/events.html` (log in as admin): create an event with "GSC, VP, VP, Ersthelfer" in the new field, save, click "Bearbeiten" on it, and confirm the field shows "GSC, VP, Ersthelfer" (deduplicated — trust Task 1's `normalizeFlags`, which already has a passing test for this). Then clear the field entirely, save, edit again, confirm it's now empty. Stop the stack afterward: `docker compose -f docker-compose.dev.yml down`.

- [ ] **Step 3: Commit**

```bash
git add frontend/admin/events.html
git commit -m "feat: let admins define per-event flags in the event form"
```

---

## Task 5: Registration form — pick flags at sign-up, remove the GSC-only checkbox

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `events` (array, each with `.flags: string[]`) already loaded by `loadEvents()`. `renderAccountFieldInput(field, value, opts)`, `collectAccountFieldValues(container, schema)` from `frontend/js/formFields.js` (already imported in this file) — reused here as the flags checkbox renderer/collector via a synthetic `{key: 'flags', type: 'multiselect', options: [...]}` field definition, instead of hand-rolled markup.
- Produces: `flagsFieldFor(event)` (module-scope helper) — later reused by Task 6's edit dialog in the same file.

- [ ] **Step 1: Remove the GSC-only checkbox, add a flags container**

In `frontend/account.html`, change:

```html
                    <div id="sc-role-panel">
                      <select id="character-select"></select>
                      <label for="character-select">Als welcher Charakter kommst du?</label>
                      <p id="no-character-hint" class="sub" style="display:none;">Du hast noch keinen passenden Charakter. <button
                          type="button" id="no-character-hint-btn" class="btn-sm btn-ghost">Charakter anlegen</button></p>
                      <label><input type="checkbox" id="gsc-toggle"> Als GSC anmelden</label>
                    </div>

                    <div id="nsc-role-panel" hidden>
                      <select id="nsc-character-select"></select>
                      <label for="nsc-character-select">NSC-Charakter (optional)</label>
                    </div>
                  </div>

                  <h3>Weitere Angaben zu dieser Anmeldung</h3>
```

to:

```html
                    <div id="sc-role-panel">
                      <select id="character-select"></select>
                      <label for="character-select">Als welcher Charakter kommst du?</label>
                      <p id="no-character-hint" class="sub" style="display:none;">Du hast noch keinen passenden Charakter. <button
                          type="button" id="no-character-hint-btn" class="btn-sm btn-ghost">Charakter anlegen</button></p>
                    </div>

                    <div id="nsc-role-panel" hidden>
                      <select id="nsc-character-select"></select>
                      <label for="nsc-character-select">NSC-Charakter (optional)</label>
                    </div>
                  </div>

                  <div id="registration-flags"></div>

                  <h3>Weitere Angaben zu dieser Anmeldung</h3>
```

(`#registration-flags` sits outside `#character-select-wrap`, independent of the SC/NSC tabs, matching the spec's "role-independent" placement.)

- [ ] **Step 2: Add `flagsFieldFor` and the render/collect wiring**

Change the variable declarations block:

```javascript
    const eventSelect = document.getElementById("event-select");
    const characterSelect = document.getElementById("character-select");
    const noCharacterHint = document.getElementById("no-character-hint");
    const gscToggle = document.getElementById("gsc-toggle");
    const scRolePanel = document.getElementById("sc-role-panel");
    const nscRolePanel = document.getElementById("nsc-role-panel");
    const roleTabButtons = [...document.querySelectorAll("#registration-role-tabs .tab-btn")];
    const nscCharacterSelect = document.getElementById("nsc-character-select");
    const registerButton = document.getElementById("register-button");
    const otFieldsContainer = document.getElementById("ot-fields");
```

to:

```javascript
    const eventSelect = document.getElementById("event-select");
    const characterSelect = document.getElementById("character-select");
    const noCharacterHint = document.getElementById("no-character-hint");
    const scRolePanel = document.getElementById("sc-role-panel");
    const nscRolePanel = document.getElementById("nsc-role-panel");
    const roleTabButtons = [...document.querySelectorAll("#registration-role-tabs .tab-btn")];
    const nscCharacterSelect = document.getElementById("nsc-character-select");
    const registerButton = document.getElementById("register-button");
    const otFieldsContainer = document.getElementById("ot-fields");
    const registrationFlagsContainer = document.getElementById("registration-flags");

    // A synthetic OT-field definition so the event's flag vocabulary can be
    // rendered/collected with the exact same generic machinery the
    // "Weitere Angaben"-OT-fields already use, instead of a second
    // hand-rolled checkbox renderer.
    function flagsFieldFor(event) {
      return { key: "flags", label: "Sonderrollen", type: "multiselect", options: event?.flags ?? [] };
    }

    function renderRegistrationFlags() {
      const event = events.find((e) => e.id === eventSelect.value);
      const field = flagsFieldFor(event);
      registrationFlagsContainer.innerHTML = field.options.length > 0
        ? renderAccountFieldInput(field, [], { idPrefix: "register-" })
        : "";
    }

    function collectRegistrationFlags() {
      return collectAccountFieldValues(registrationFlagsContainer, [flagsFieldFor(events.find((e) => e.id === eventSelect.value))]).flags ?? [];
    }
```

- [ ] **Step 3: Re-render flags when the event selection changes, and after events first load**

Change:

```javascript
    eventSelect.addEventListener("change", updateRegisterButtonLabel);
```

to:

```javascript
    eventSelect.addEventListener("change", () => {
      updateRegisterButtonLabel();
      renderRegistrationFlags();
    });
```

Change `populateEventOptions`:

```javascript
    function populateEventOptions() {
      const visibleEvents = canEditCharacters
        ? events
        : events.filter((e) => e.is_active);
      eventSelect.innerHTML = renderEventOptions(visibleEvents);
      updateRegisterButtonLabel();
    }
```

to:

```javascript
    function populateEventOptions() {
      const visibleEvents = canEditCharacters
        ? events
        : events.filter((e) => e.is_active);
      eventSelect.innerHTML = renderEventOptions(visibleEvents);
      updateRegisterButtonLabel();
      renderRegistrationFlags();
    }
```

- [ ] **Step 4: Send flags on submit instead of `isGsc`**

Change the submit handler:

```javascript
    registrationForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const eventId = eventSelect.value;

      let conRole, characterId, isGsc;
      if (isNscRoleSelected()) {
        conRole = "nsc";
        characterId = nscCharacterSelect.value || undefined;
        isGsc = false;
      } else {
        characterId = characterSelect.value || undefined;
        if (!characterId) {
          notify("Wähle einen Charakter.", "error");
          return;
        }
        conRole = "sc";
        isGsc = gscToggle.checked;
      }

      try {
        await api.post(`/events/${eventId}/register`, {
          conRole,
          characterId,
          isGsc,
          otFields: collectOtFields(),
        });
```

to:

```javascript
    registrationForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const eventId = eventSelect.value;

      let conRole, characterId;
      if (isNscRoleSelected()) {
        conRole = "nsc";
        characterId = nscCharacterSelect.value || undefined;
      } else {
        characterId = characterSelect.value || undefined;
        if (!characterId) {
          notify("Wähle einen Charakter.", "error");
          return;
        }
        conRole = "sc";
      }

      try {
        await api.post(`/events/${eventId}/register`, {
          conRole,
          characterId,
          flags: collectRegistrationFlags(),
          otFields: collectOtFields(),
        });
```

- [ ] **Step 5: Show flags generically in `labelForRegisteredAs` instead of the old SC-only GSC suffix**

Change:

```javascript
    function labelForRegisteredAs(r) {
      if (r.conRole === "sc") return `Angemeldet als SC${r.isGsc ? " (GSC)" : ""}: ${r.characterName}`;
      if (r.conRole === "nsc") {
        return r.characterName
          ? `Angemeldet als NSC: ${r.characterName}`
          : "Angemeldet als NSC";
      }
      return `Angemeldet als ${CON_ROLE_LABELS[r.conRole] ?? r.conRole}`;
    }
```

to:

```javascript
    function labelForRegisteredAs(r) {
      const flagsSuffix = r.flags && r.flags.length > 0 ? ` (${r.flags.join(", ")})` : "";
      if (r.conRole === "sc") return `Angemeldet als SC${flagsSuffix}: ${r.characterName}`;
      if (r.conRole === "nsc") {
        return r.characterName
          ? `Angemeldet als NSC${flagsSuffix}: ${r.characterName}`
          : `Angemeldet als NSC${flagsSuffix}`;
      }
      return `Angemeldet als ${CON_ROLE_LABELS[r.conRole] ?? r.conRole}${flagsSuffix}`;
    }
```

- [ ] **Step 6: Manually verify in the browser**

No automated UI-interaction tests exist for this project's account page (same situation as Task 4). Start the dev stack:

```bash
docker compose -f docker-compose.dev.yml up -d db app
```

In the browser: as admin, create/edit an event with flags "GSC, VP" (via Task 4's field) and activate it. Go to `account.html#veranstaltung`, confirm a "Sonderrollen" checkbox group with "GSC" and "VP" appears below the SC/NSC tabs regardless of which tab is selected, and is absent for an event with no flags. Register once with a flag checked; confirm "Meine Anmeldungen" shows it appended in parentheses (e.g. "Angemeldet als SC (GSC): ..."). Clean up any test event/registration/character you created via the API (`DELETE /events/:id`, `DELETE /characters/:id`) so the dev DB isn't left with clutter, then `docker compose -f docker-compose.dev.yml down`.

- [ ] **Step 7: Commit**

```bash
git add frontend/account.html
git commit -m "feat: let participants pick event flags at registration, independent of SC/NSC role"
```

---

## Task 6: Edit-OT dialog — flags editable after registration

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `flagsFieldFor(event)` from Task 5 (same file, module scope). `events` array with `.flags`. `otFieldValuesEqual(field, a, b)` from `frontend/js/formFields.js` (already imported).

- [ ] **Step 1: Add a flags container to the edit dialog**

In `frontend/account.html`, change:

```html
                <dialog id="edit-ot-dialog">
                  <h3>Anmeldungsdaten bearbeiten</h3>
                  <p class="lede">Diese Änderung benachrichtigt die Orga und Admin dieses Events per E-Mail.</p>
                  <div id="edit-ot-fields"></div>
```

to:

```html
                <dialog id="edit-ot-dialog">
                  <h3>Anmeldungsdaten bearbeiten</h3>
                  <p class="lede">Diese Änderung benachrichtigt die Orga und Admin dieses Events per E-Mail.</p>
                  <div id="edit-flags"></div>
                  <div id="edit-ot-fields"></div>
```

- [ ] **Step 2: Render it when the dialog opens**

Change `openEditOtDialog`:

```javascript
    function openEditOtDialog(eventId) {
      const registration = currentRegistrations.find((r) => r.eventId === eventId);
      if (!registration) return;
      editingEventId = eventId;
      editOtFieldsContainer.innerHTML = registrationSchema
        .map((field) => renderAccountFieldInput(field, registration[field.key], { idPrefix: "edit-" }))
        .join("");
      attachLiveValidation(editOtFieldsContainer);
      editOtDialog.showModal();
    }
```

to:

```javascript
    const editFlagsContainer = document.getElementById("edit-flags");

    function openEditOtDialog(eventId) {
      const registration = currentRegistrations.find((r) => r.eventId === eventId);
      if (!registration) return;
      editingEventId = eventId;
      const event = events.find((e) => e.id === eventId);
      const flagsField = flagsFieldFor(event);
      editFlagsContainer.innerHTML = flagsField.options.length > 0
        ? renderAccountFieldInput(flagsField, registration.flags ?? [], { idPrefix: "edit-" })
        : "";
      editOtFieldsContainer.innerHTML = registrationSchema
        .map((field) => renderAccountFieldInput(field, registration[field.key], { idPrefix: "edit-" }))
        .join("");
      attachLiveValidation(editOtFieldsContainer);
      editOtDialog.showModal();
    }
```

(`const editFlagsContainer = document.getElementById("edit-flags");` is placed right above the function so it's declared once, next to `editOtFieldsContainer`'s own declaration a few lines above in the file — either placement works since both are `const` at module scope; keeping it adjacent to its first use here is just for readability.)

- [ ] **Step 3: Include changed flags in the save payload**

Change the save handler:

```javascript
    document.getElementById("edit-ot-save").addEventListener("click", async () => {
      const registration = currentRegistrations.find(
        (r) => r.eventId === editingEventId,
      );
      const collected = nullifyBlankNumberFields(registrationSchema, collectAccountFieldValues(editOtFieldsContainer, registrationSchema));
      const payload = {};
      for (const field of registrationSchema) {
        const originalValue = registration?.[field.key] ?? (field.type === "boolean" ? false : "");
        const newValue = collected[field.key];
        // Only send a field that actually changed -- a save that touched nothing
        // must not PUT .../ot-fields, since a successful call mails every event
        // orga/hilfs_orga plus every admin/moderator.
        if (otFieldValuesEqual(field, originalValue, newValue)) continue;
        payload[field.key] = newValue;
      }
      if (Object.keys(payload).length === 0) {
        editOtDialog.close();
        return;
      }
```

to:

```javascript
    document.getElementById("edit-ot-save").addEventListener("click", async () => {
      const registration = currentRegistrations.find(
        (r) => r.eventId === editingEventId,
      );
      const collected = nullifyBlankNumberFields(registrationSchema, collectAccountFieldValues(editOtFieldsContainer, registrationSchema));
      const payload = {};
      for (const field of registrationSchema) {
        const originalValue = registration?.[field.key] ?? (field.type === "boolean" ? false : "");
        const newValue = collected[field.key];
        // Only send a field that actually changed -- a save that touched nothing
        // must not PUT .../ot-fields, since a successful call mails every event
        // orga/hilfs_orga plus every admin/moderator.
        if (otFieldValuesEqual(field, originalValue, newValue)) continue;
        payload[field.key] = newValue;
      }

      const flagsField = flagsFieldFor(events.find((e) => e.id === editingEventId));
      const collectedFlags = collectAccountFieldValues(editFlagsContainer, [flagsField]).flags;
      if (!otFieldValuesEqual(flagsField, registration?.flags ?? [], collectedFlags ?? [])) {
        payload.flags = collectedFlags ?? [];
      }

      if (Object.keys(payload).length === 0) {
        editOtDialog.close();
        return;
      }
```

- [ ] **Step 4: Manually verify in the browser**

Same dev-stack setup as Task 5 (`docker compose -f docker-compose.dev.yml up -d db app`). Register for a flagged event with no flags selected, then click "Bearbeiten" on the active-registration panel, check a flag, save — confirm "Meine Anmeldungen" now shows it. Open the edit dialog again without changing anything and save (or rather, confirm the Speichern button click with nothing touched doesn't fire a network request — check via the browser's network tab) to confirm the "only send what changed" guard still holds when flags are untouched. Clean up test data, then `docker compose -f docker-compose.dev.yml down`.

- [ ] **Step 5: Commit**

```bash
git add frontend/account.html
git commit -m "feat: make event flags editable after registration via the existing edit dialog"
```

---

## Task 7: Admin check-in — generic flag badges

**Files:**
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `lookup.flags`/`p.flags` (string array) from `GET /events/:eventId/scan-lookup` and `GET /events/:id/participants` (Task 2).

- [ ] **Step 1: Replace the `isGsc` special case in the scan dialog**

In `frontend/admin/checkin.html`, change:

```javascript
  document.getElementById('scan-group').textContent = `Kategorie: ${CON_ROLE_LABELS[lookup.conRole] ?? lookup.conRole}${lookup.isGsc ? ' (GSC)' : ''}${lookup.nscAvailable ? ' (auch NSC-bereit)' : ''}`;
```

to:

```javascript
  const scanFlagsSuffix = (lookup.flags ?? []).length > 0 ? ` (${lookup.flags.join(', ')})` : '';
  document.getElementById('scan-group').textContent = `Kategorie: ${CON_ROLE_LABELS[lookup.conRole] ?? lookup.conRole}${scanFlagsSuffix}${lookup.nscAvailable ? ' (auch NSC-bereit)' : ''}`;
```

- [ ] **Step 2: Replace the `isGsc` badge in the participant list**

Change:

```javascript
function renderConRoleCell(p) {
  const label = CON_ROLE_LABELS[p.conRole] ?? p.conRole ?? '–';
  const badge = (p.isGsc ? ' <span class="tag">GSC</span>' : '') + (p.nscAvailable ? ' <span class="tag">auch NSC-bereit</span>' : '');
```

to:

```javascript
function renderConRoleCell(p) {
  const label = CON_ROLE_LABELS[p.conRole] ?? p.conRole ?? '–';
  const flagBadges = (p.flags ?? []).map((f) => ` <span class="tag">${escapeHtml(f)}</span>`).join('');
  const badge = flagBadges + (p.nscAvailable ? ' <span class="tag">auch NSC-bereit</span>' : '');
```

- [ ] **Step 3: Manually verify in the browser**

Same dev-stack setup as Task 5/6. Register someone for a flagged event with a flag selected (via account.html, or by calling the API directly with `fetch` in the browser console like earlier verification steps in this project's history), then open `admin/checkin.html` for that event and confirm the flag renders as a tag next to their role, and the QR-scan dialog's "Kategorie:" line includes it in parentheses. Clean up test data, then `docker compose -f docker-compose.dev.yml down`.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/checkin.html
git commit -m "feat: show event flags as generic badges in check-in, replacing the GSC special case"
```

---

## Task 8: Full suite, migration sanity check against real dev data, memory update

**Files:**
- None modified — verification only.

- [ ] **Step 1: Run the full test suite**

```bash
docker compose -f docker-compose.dev.yml up -d db-test
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" npm test
```

Expected: every test passes (check the final `# pass`/`# fail` summary line), no `not ok` lines anywhere in the output.

- [ ] **Step 2: Apply the migration to the local dev database and sanity-check the GSC backfill**

The dev database may still have `is_gsc = true` rows from earlier manual testing this session (or none — either is fine, this step just needs to not error and to migrate correctly either way).

```bash
docker compose -f docker-compose.dev.yml up -d db app
docker compose -f docker-compose.dev.yml exec -T app npm run migrate
```

Expected: `"applied migration","file":"044_event_flags.sql"` in the output, no error. Then check the backfill directly:

```bash
docker compose -f docker-compose.dev.yml exec -T db psql -U app -d pakyrion -t -c "SELECT id, flags FROM events WHERE 'GSC' = ANY(flags);"
docker compose -f docker-compose.dev.yml exec -T db psql -U app -d pakyrion -t -c "SELECT event_id, user_id, flags FROM registrations WHERE 'GSC' = ANY(flags);"
```

If either query errors (e.g. `column "is_gsc" does not exist` from a stale query, or a constraint violation) or the two result sets don't correspond 1:1 with each other (every registration's event should appear in the first query's list), stop and investigate before continuing — this is the migration's one-way, not-reversible-without-backup step (spec section 9).

Stop the stack afterward:

```bash
docker compose -f docker-compose.dev.yml down
```

- [ ] **Step 3: Update the stale memory file**

Read `C:\Users\info\.claude\projects\E--Werkbank-pakyrion-teilnehmerRegistrierung\memory\project_gsc_is_a_registration_flag.md`. It currently documents `registrations.is_gsc` as the final state — that's now superseded by this plan (`registrations.flags`/`events.flags`, generic, not GSC-specific). Rewrite its body to describe the current state (event-scoped `flags text[]` vocabulary + registration-scoped `flags text[]` selection, GSC just one possible value, migration chain 036→042→043→044), keep the same `name`/`description` frontmatter unless the description also needs updating to match, and update its one-line entry in `MEMORY.md` to match. This step has no test — it's a plain file edit, done directly (not through git commit; the memory system lives outside this repo).

- [ ] **Step 4: Final commit**

If steps 1-2 revealed no issues, this task has no code changes of its own to commit (it's the plan's verification task). Confirm `git status` shows every prior task's commit already landed and the working tree is otherwise clean of unrelated changes:

```bash
git status
git log --oneline -8
```

Expected: the log shows the 7 feature commits from Tasks 1-7, in order, and nothing uncommitted remains from this plan's own work (other pre-existing uncommitted work from earlier in the session, if any, is not this task's concern).
