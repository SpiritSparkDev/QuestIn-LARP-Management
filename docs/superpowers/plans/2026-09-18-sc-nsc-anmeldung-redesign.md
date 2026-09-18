# SC/NSC-Anmeldung Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the event registration form to be character-first (pick an SC character, or none), add an independent "also available as NSC" toggle, and move GSC from a per-registration role into a character-level flag.

**Architecture:** One additive DB migration (new `characters.is_gsc` column, new `registrations.nsc_available`/`nsc_character_id` columns, a backfill of existing `con_role='gsc'` rows, and a narrowed CHECK constraint), backend validation changes in `backend/registrations/repository.js` and `backend/characters/repository.js`, and a frontend redesign of the registration and character forms in `frontend/account.html` plus a label update in `frontend/admin/checkin.html`.

**Tech Stack:** Node.js (native `node:test`), PostgreSQL, plain HTML/JS frontend (no build step).

**Spec:** `docs/superpowers/specs/2026-09-18-sc-nsc-anmeldung-redesign-design.md`

## Global Constraints

- `con_role` no longer accepts `'gsc'` anywhere (backend validation, frontend dropdowns, labels).
- `nscAvailable`/`nscCharacterId` are only ever non-default when `con_role === 'sc'`; sending them with any other `con_role` is a `400 INVALID_NSC_AVAILABILITY`.
- `con_role === 'nsc'` no longer requires a `characterId` (it becomes optional, but if provided must still be the caller's own `nsc`-class character).
- Helfer/Orga/Hilfs-Orga selection and permission logic (`canGrantStaffConRole`) are unchanged.
- Every new/changed backend response field follows the exact casing already used at that call site (see Task 3: `registerForEvent`/`setConRole` return snake_case `nsc_available`/`nsc_character_id`; `listRegistrationsForUser`/`listParticipantsForEvent`/`getScanLookup` return camelCase `nscAvailable`/`nscCharacterId`).
- Run the full test suite from the repo root with:
  ```bash
  TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" npm test
  ```

---

## Task 1: Database migration

**Files:**
- Create: `db/migrations/036_sc_nsc_anmeldung_redesign.sql`

**Interfaces:**
- Consumes: nothing (pure SQL migration).
- Produces: `characters.is_gsc boolean`; `registrations.nsc_available boolean`, `registrations.nsc_character_id uuid`; a narrowed `registrations_character_con_role_check` constraint that no longer allows `'gsc'` and no longer requires a `character_id` for `'nsc'`. All later tasks depend on these columns existing.

- [ ] **Step 1: Write the migration**

Create `db/migrations/036_sc_nsc_anmeldung_redesign.sql`:

```sql
-- GSC becomes a character-level flag instead of a per-registration con_role.
ALTER TABLE characters ADD COLUMN is_gsc boolean NOT NULL DEFAULT false;

-- Backfill: mark the character of every existing gsc registration as GSC,
-- then collapse con_role='gsc' into 'sc' (must run in this order -- the
-- UPDATE below would otherwise erase the con_role='gsc' rows the SELECT
-- above needs).
UPDATE characters SET is_gsc = true
WHERE id IN (SELECT character_id FROM registrations WHERE con_role = 'gsc');

UPDATE registrations SET con_role = 'sc' WHERE con_role = 'gsc';

-- New columns for the "sc + also available as NSC" case.
ALTER TABLE registrations ADD COLUMN nsc_available boolean NOT NULL DEFAULT false;
ALTER TABLE registrations ADD COLUMN nsc_character_id uuid REFERENCES characters(id);

-- Narrow the constraint: 'gsc' is gone, and 'nsc' no longer requires a
-- character_id (it becomes optional -- see backend/registrations/repository.js).
ALTER TABLE registrations DROP CONSTRAINT registrations_character_con_role_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role = 'sc' AND character_id IS NOT NULL)
    OR (con_role = 'nsc')
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga') AND character_id IS NULL)
  );
```

- [ ] **Step 2: Verify it applies cleanly**

Run:
```bash
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" node --test tests/integration/registrations.test.js
```
Expected: all existing tests still PASS (this file's `await runMigrations()` at module load applies your new migration against the test DB; a SQL error here would fail every test in the file, not just one).

- [ ] **Step 3: Commit**

```bash
git add db/migrations/036_sc_nsc_anmeldung_redesign.sql
git commit -m "feat: add is_gsc character flag and nsc_available registration columns"
```

---

## Task 2: Backend — `is_gsc` on characters

**Files:**
- Modify: `backend/characters/repository.js`
- Modify: `backend/characters/routes.js`
- Test: `tests/integration/characters.test.js`

**Interfaces:**
- Consumes: `characters.is_gsc` column (Task 1).
- Produces: `createCharacter(userId, { characterClass, name, data, isGsc })` and `updateCharacter(id, userId, { name, data, isGsc })` — both now accept an optional `isGsc` and both return an object that includes `is_gsc` (via `SELECT_COLUMNS`). `POST /characters` and `PUT /characters/:id` accept `body.isGsc`. Task 5 (frontend character form) depends on the response containing `is_gsc` and on being able to send `isGsc` in the request body.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/characters.test.js` (after the existing `PUT /characters/:id replaces sc-class data` test):

```javascript
test('POST /characters accepts isGsc for sc-class characters', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const res = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' }, isGsc: true }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).is_gsc, true);
  });
});

test('isGsc is ignored for nsc-class characters', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const res = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ class: 'nsc', name: 'Elenwe', isGsc: true }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).is_gsc, false);
  });
});

test('PUT /characters/:id updates isGsc, and omitting it leaves the existing value unchanged', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const createRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ name: 'Aldric', data: { fraction: 'Nordmark' }, isGsc: true }),
    });
    const { id } = await createRes.json();

    const putRes = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ data: { fraction: 'Suedmark' } }),
    });
    assert.equal(putRes.status, 200);
    assert.equal((await putRes.json()).is_gsc, true);

    const clearRes = await fetch(`http://localhost:${port}/characters/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ isGsc: false }),
    });
    assert.equal(clearRes.status, 200);
    assert.equal((await clearRes.json()).is_gsc, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" node --test tests/integration/characters.test.js`
Expected: the 3 new tests FAIL (`is_gsc` is `undefined`, since neither the column read nor the write path exist yet).

- [ ] **Step 3: Implement**

In `backend/characters/repository.js`, change:

```javascript
const SELECT_COLUMNS = 'id, user_id, class, name, data, created_at';
```
to:
```javascript
const SELECT_COLUMNS = 'id, user_id, class, name, data, is_gsc, created_at';
```

Replace `createCharacter`:

```javascript
export async function createCharacter(userId, { characterClass = 'sc', name, data, isGsc = false }) {
  const schema = await schemaForClass(characterClass);
  const errors = validateCharacterData(schema, data ?? {});
  if (errors.length > 0) {
    const err = new Error('invalid character data');
    err.code = 'INVALID_CHARACTER_DATA';
    err.details = errors;
    throw err;
  }
  // isGsc is a system flag meaningful only for SC characters -- silently
  // dropped for nsc rather than rejected, so the frontend never needs a
  // conditional check before sending it.
  const gscFlag = characterClass === 'sc' && Boolean(isGsc);
  const { rows } = await query(
    `INSERT INTO characters (user_id, class, name, data, is_gsc)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [userId, characterClass, name, JSON.stringify(data ?? {}), gscFlag]
  );
  return rows[0];
}
```

Replace `updateCharacter`:

```javascript
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

  // Same "sc only" rule as createCharacter; NULL (not false) means "don't
  // touch is_gsc" so COALESCE below preserves the existing value.
  const gscFlag = isGsc !== undefined && character.class === 'sc' ? Boolean(isGsc) : null;

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       data = COALESCE($4, data),
       is_gsc = COALESCE($5, is_gsc)
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, name ?? null, newData !== undefined ? JSON.stringify(newData) : null, gscFlag]
  );
  return rows[0];
}
```

In `backend/characters/routes.js`, change the `POST /characters` handler's destructuring and call:

```javascript
  const { class: characterClass = 'sc', name, data, isGsc } = body;
  if (characterClass !== 'sc' && characterClass !== 'nsc') {
    return { status: 400, body: { error: 'class must be "sc" or "nsc"' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }

  try {
    const character = await createCharacter(user.id, { characterClass, name, data, isGsc });
```

(The `PUT /characters/:id` handler already forwards the whole `body` to `updateCharacter` unchanged — no edit needed there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" node --test tests/integration/characters.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/characters/repository.js backend/characters/routes.js tests/integration/characters.test.js
git commit -m "feat: add isGsc flag to character create/update"
```

---

## Task 3: Backend — registrations con_role/nsc_available logic

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Test: `tests/integration/registrations.test.js`

**Interfaces:**
- Consumes: `registrations.nsc_available`/`nsc_character_id` columns (Task 1).
- Produces: `registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, otFields, requestingUser)` and `setConRole(eventId, userId, conRole, characterId, nscAvailable, nscCharacterId, requestingUser)` — both now take two extra positional params and return an object with `nsc_available`/`nsc_character_id`. `listRegistrationsForUser`, `listParticipantsForEvent`, `getScanLookup` now include `nscAvailable`/`nscCharacterId` in every returned entry. New error code `INVALID_NSC_AVAILABILITY` → `400`. Task 4, 6 and 7 (frontend) depend on these exact field names and error code.

- [ ] **Step 1: Write the failing tests**

First, fix the stale title of the existing test (it says "sc/nsc/gsc/helfer" but only ever exercised `helfer`, and `gsc` no longer exists) — in `tests/integration/registrations.test.js`, change:

```javascript
test('a participant can self-register with a self-service con_role (sc/nsc/gsc/helfer)', async () => {
```
to:
```javascript
test('a participant can self-register with a self-service con_role (sc/nsc/helfer)', async () => {
```

Then add these new tests (after the `registering with con_role helfer and a characterId set is rejected` test):

```javascript
test('registering with con_role nsc and no characterId now succeeds', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.con_role, 'nsc');
    assert.equal(body.character_id, null);
  });
});

test('registering with con_role nsc and an own nsc-class character still works', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', characterId: nscCharacterId }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).character_id, nscCharacterId);
  });
});

test('registering with con_role sc and nscAvailable=true stores both, with an optional nsc character', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: true, nscCharacterId }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.con_role, 'sc');
    assert.equal(body.character_id, scCharacterId);
    assert.equal(body.nsc_available, true);
    assert.equal(body.nsc_character_id, nscCharacterId);
  });
});

test('nscAvailable/nscCharacterId are rejected for any con_role other than sc', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', nscAvailable: true }),
    });
    assert.equal(res.status, 400);
  });
});

test('nscCharacterId without nscAvailable=true is rejected', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: false, nscCharacterId }),
    });
    assert.equal(res.status, 400);
  });
});

test('an sc-class character cannot be used as nscCharacterId (class mismatch)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const otherScCharacterId = await makeCharacter(port, cookie, 'sc', 'Bram');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: true, nscCharacterId: otherScCharacterId }),
    });
    assert.equal(res.status, 400);
  });
});

test('an nsc character reused as nscCharacterId across two sc registrations is allowed (nsc stays reusable)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId1 = await makeEventNamed('Reg Test Con NSC-Reuse A', '2027-09-01');
    const eventId2 = await makeEventNamed('Reg Test Con NSC-Reuse B', '2027-09-02');
    const scCharacterId1 = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const scCharacterId2 = await makeCharacter(port, cookie, 'sc', 'Bram');
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res1 = await fetch(`http://localhost:${port}/events/${eventId1}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId1, nscAvailable: true, nscCharacterId }),
    });
    assert.equal(res1.status, 201);

    const res2 = await fetch(`http://localhost:${port}/events/${eventId2}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId2, nscAvailable: true, nscCharacterId }),
    });
    assert.equal(res2.status, 201);
  });
});

test('GET /registrations includes nscAvailable/nscCharacterId', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: true }),
    });

    const list = await (await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: cookie } })).json();
    const registration = list.find((r) => r.eventId === eventId);
    assert.equal(registration.nscAvailable, true);
    assert.equal(registration.nscCharacterId, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" node --test tests/integration/registrations.test.js`
Expected: the new tests FAIL (nsc still requires a character; `nscAvailable`/`nscCharacterId` are accepted/ignored with no validation and never stored or returned).

- [ ] **Step 3: Implement**

In `backend/registrations/repository.js`, replace the constants and `resolveCharacterId`:

```javascript
const SELF_SERVICE_CON_ROLES = ['sc', 'nsc', 'helfer'];
const STAFF_CON_ROLES = ['orga', 'hilfs_orga'];
const ALL_CON_ROLES = [...SELF_SERVICE_CON_ROLES, ...STAFF_CON_ROLES];
// Roles that don't play a character on-site, so approval doesn't require one assigned.
const CHARACTER_EXEMPT_CON_ROLES = [...STAFF_CON_ROLES, 'helfer'];
// A registration's character_id: 'sc' must have one, 'nsc' may optionally
// have one, every other role must not.
const CHARACTER_REQUIRED_CON_ROLES = ['sc'];
const CHARACTER_OPTIONAL_CON_ROLES = ['nsc'];
```

```javascript
// Validates characterId against con_role: 'sc' must have one that exists,
// belongs to userId, and is class='sc'; 'nsc' may optionally have one of
// class='nsc'; every other con_role must NOT have one.
// For an sc-class character, also enforces "at most one registration ever"
// (design spec 2026-09-16, section 4.3) -- excludes the caller's own
// (eventId, userId) row so re-saving an existing registration's con-role
// doesn't flag itself as a conflict. NSC stays exempt: it remains reusable
// across many events, unchanged from before this spec.
// Returns the characterId to store (null when none applies).
async function resolveCharacterId(userId, conRole, characterId, eventId) {
  const isRequired = CHARACTER_REQUIRED_CON_ROLES.includes(conRole);
  const isOptional = CHARACTER_OPTIONAL_CON_ROLES.includes(conRole);
  if (!isRequired && !isOptional) {
    if (characterId) {
      const err = new Error(`Für die Rolle "${conRole}" darf kein Charakter angegeben werden.`);
      err.code = 'CHARACTER_NOT_ALLOWED';
      throw err;
    }
    return null;
  }
  if (!characterId) {
    if (isRequired) {
      const err = new Error(`Für die Rolle "${conRole}" ist ein Charakter erforderlich.`);
      err.code = 'CHARACTER_REQUIRED';
      throw err;
    }
    return null;
  }
  const { rows } = await query('SELECT user_id, class FROM characters WHERE id = $1', [characterId]);
  if (rows.length === 0) {
    const err = new Error('character not found');
    err.code = 'CHARACTER_NOT_FOUND';
    throw err;
  }
  const character = rows[0];
  if (character.user_id !== userId) {
    const err = new Error('character does not belong to this user');
    err.code = 'CHARACTER_FORBIDDEN';
    throw err;
  }
  const expectedClass = conRole === 'nsc' ? 'nsc' : 'sc';
  if (character.class !== expectedClass) {
    const err = new Error(`Rolle "${conRole}" erfordert einen Charakter der Klasse "${expectedClass}".`);
    err.code = 'CHARACTER_CLASS_MISMATCH';
    throw err;
  }
  if (expectedClass === 'sc') {
    const { rows: existing } = await query(
      'SELECT 1 FROM registrations WHERE character_id = $1 AND NOT (event_id = $2 AND user_id = $3)',
      [characterId, eventId, userId]
    );
    if (existing.length > 0) {
      const err = new Error('Dieser Charakter ist bereits für ein anderes Event angemeldet.');
      err.code = 'CHARACTER_ALREADY_REGISTERED';
      throw err;
    }
  }
  return characterId;
}

// Validates the "sc + also available as NSC" bolt-on: only meaningful when
// con_role='sc'; nscCharacterId (if given) must be the caller's own
// nsc-class character, with no "at most one" restriction (nsc characters
// stay reusable, same as resolveCharacterId's 'nsc' case).
// Returns { nscAvailable, nscCharacterId } to store.
async function resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId) {
  const available = Boolean(nscAvailable);
  if (conRole !== 'sc') {
    if (available || nscCharacterId) {
      const err = new Error('nscAvailable/nscCharacterId sind nur zusammen mit con_role "sc" erlaubt.');
      err.code = 'INVALID_NSC_AVAILABILITY';
      throw err;
    }
    return { nscAvailable: false, nscCharacterId: null };
  }
  if (nscCharacterId && !available) {
    const err = new Error('nscCharacterId erfordert nscAvailable = true.');
    err.code = 'INVALID_NSC_AVAILABILITY';
    throw err;
  }
  if (!available) return { nscAvailable: false, nscCharacterId: null };
  if (!nscCharacterId) return { nscAvailable: true, nscCharacterId: null };

  const { rows } = await query('SELECT user_id, class FROM characters WHERE id = $1', [nscCharacterId]);
  if (rows.length === 0) {
    const err = new Error('character not found');
    err.code = 'CHARACTER_NOT_FOUND';
    throw err;
  }
  const character = rows[0];
  if (character.user_id !== userId) {
    const err = new Error('character does not belong to this user');
    err.code = 'CHARACTER_FORBIDDEN';
    throw err;
  }
  if (character.class !== 'nsc') {
    const err = new Error('nscCharacterId erfordert einen Charakter der Klasse "nsc".');
    err.code = 'CHARACTER_CLASS_MISMATCH';
    throw err;
  }
  return { nscAvailable: true, nscCharacterId };
}
```

Replace `registerForEvent`'s signature and body (keep everything before `const resolvedCharacterId = ...` unchanged):

```javascript
export async function registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, otFields, requestingUser) {
  const event = await getEvent(eventId);
  if (!event) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  if (!ALL_CON_ROLES.includes(conRole)) {
    const err = new Error(`conRole must be one of: ${ALL_CON_ROLES.join(', ')}`);
    err.code = 'INVALID_CON_ROLE';
    throw err;
  }

  if (STAFF_CON_ROLES.includes(conRole) && !(await canGrantStaffConRole(eventId, requestingUser))) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may set this role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }

  if (SELF_SERVICE_CON_ROLES.includes(conRole) && !requestingUser.group.canEditCharacters && !event.is_active) {
    const err = new Error('Anmeldung ist nur für das aktuell aktive Event möglich.');
    err.code = 'EVENT_NOT_ACTIVE';
    throw err;
  }

  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);

  const schema = await getRegistrationFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields?.[field.key] !== undefined) data[field.key] = otFields[field.key];
  }

  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id, con_role, character_id, nsc_available, nsc_character_id, registration_data_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, checked_in_at, checked_out_at`,
      [userId, eventId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId, encryptFieldBlob(data)]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('Bereits für dieses Event angemeldet.');
      dup.code = 'ALREADY_REGISTERED';
      throw dup;
    }
    throw err;
  }
}
```

Replace `setConRole`:

```javascript
export async function setConRole(eventId, userId, conRole, characterId, nscAvailable, nscCharacterId, requestingUser) {
  if (!ALL_CON_ROLES.includes(conRole)) {
    const err = new Error(`conRole must be one of: ${ALL_CON_ROLES.join(', ')}`);
    err.code = 'INVALID_CON_ROLE';
    throw err;
  }
  const isOwnRegistration = userId === requestingUser.id;
  const staffGrantOk = await canGrantStaffConRole(eventId, requestingUser);
  if (!isOwnRegistration && !staffGrantOk) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may change another user\'s con_role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }
  if (STAFF_CON_ROLES.includes(conRole) && !staffGrantOk) {
    const err = new Error('forbidden: only an existing orga/hilfs_orga for this event, or a moderator/admin, may set this role');
    err.code = 'FORBIDDEN_CON_ROLE';
    throw err;
  }

  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId, eventId);
  const resolvedNsc = await resolveNscAvailability(userId, conRole, nscAvailable, nscCharacterId);

  const { rows } = await query(
    `UPDATE registrations SET con_role = $3, character_id = $4, nsc_available = $5, nsc_character_id = $6
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, nsc_available, nsc_character_id, checked_in_at, checked_out_at`,
    [eventId, userId, conRole, resolvedCharacterId, resolvedNsc.nscAvailable, resolvedNsc.nscCharacterId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}
```

Update `listRegistrationsForUser`:

```javascript
export async function listRegistrationsForUser(userId) {
  const { rows } = await query(
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.nsc_available, r.nsc_character_id, r.checked_in_at, r.checked_out_at,
            r.registration_data_enc
     FROM registrations r
     JOIN events e ON e.id = r.event_id
     WHERE r.user_id = $1
     ORDER BY e.event_date`,
    [userId]
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    eventName: r.event_name,
    eventDate: r.event_date,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    nscAvailable: r.nsc_available,
    nscCharacterId: r.nsc_character_id,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    ...decryptFieldBlob(r.registration_data_enc),
  }));
}
```

Update `listParticipantsForEvent`'s registration query and mapping:

```javascript
  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.nsc_available, r.nsc_character_id, r.checked_in_at, r.checked_out_at,
            u.account_data_enc, r.registration_data_enc
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
```

and, inside the `registrations.map((r) => ({ ... }))` block, add the two new fields:

```javascript
    return {
      userId: r.user_id,
      invitationId: null,
      name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
      status: r.status,
      conRole: r.con_role,
      nscAvailable: r.nsc_available,
      nscCharacterId: r.nsc_character_id,
      checkedInAt: r.checked_in_at,
      checkedOutAt: r.checked_out_at,
      characters: charactersByUser.get(r.user_id) ?? [],
      otFields,
    };
```

Update `getScanLookup`:

```javascript
export async function getScanLookup(eventId, userId) {
  const { rows } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status, r.con_role, r.nsc_available
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     JOIN groups g ON g.id = u.group_id
     WHERE r.event_id = $1 AND r.user_id = $2`,
    [eventId, userId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const { rows: characters } = await query(
    `SELECT c.id, c.name
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1 AND r.user_id = $2`,
    [eventId, userId]
  );
  return {
    userId: r.user_id,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    group: r.group_key,
    status: r.status,
    conRole: r.con_role,
    nscAvailable: r.nsc_available,
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
  };
}
```

In `backend/registrations/routes.js`, update the `POST /events/:id/register` handler:

```javascript
router.post('/events/:id/register', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await registerForEvent(user.id, params.id, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, body.otFields, user);
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    if (err.code === 'EVENT_NOT_ACTIVE') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_REQUIRED' || err.code === 'CHARACTER_NOT_ALLOWED' || err.code === 'CHARACTER_CLASS_MISMATCH') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'INVALID_NSC_AVAILABILITY') return { status: 400, body: { error: err.message } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));
```

And the `PUT /events/:id/registrations/:userId/con-role` handler:

```javascript
router.put('/events/:id/registrations/:userId/con-role', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await setConRole(params.id, params.userId, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId, user);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_REQUIRED' || err.code === 'CHARACTER_NOT_ALLOWED' || err.code === 'CHARACTER_CLASS_MISMATCH') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'INVALID_NSC_AVAILABILITY') return { status: 400, body: { error: err.message } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));
```

- [ ] **Step 4: Fix a now-stale comment**

The comment right above `approveRegistration` is no longer accurate (`gsc` is gone, and `nsc` no longer guarantees a `character_id`). Replace:

```javascript
// The character-existence check from Teil 1 is gone: the
// registrations_character_con_role_check CHECK constraint now guarantees
// every sc/gsc/nsc registration already has a character_id at INSERT time,
// so there's nothing left to verify here.
export async function approveRegistration(eventId, userId) {
```

with:

```javascript
// The character-existence check from Teil 1 is gone: the
// registrations_character_con_role_check CHECK constraint enforces
// character_id at INSERT time for 'sc' (required) and forbids it for
// helfer/orga/hilfs_orga; 'nsc' may or may not have one (see
// resolveNscAvailability/resolveCharacterId above) -- either way, there's
// nothing left to verify here.
export async function approveRegistration(eventId, userId) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" node --test tests/integration/registrations.test.js`
Expected: all tests PASS.

- [ ] **Step 7: Run the checkin and scanLookup suites too**

Run: `TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" node --test tests/integration/checkin.test.js tests/integration/scanLookup.test.js`
Expected: all tests PASS (neither file asserts full-object equality on the participant/lookup shape, so adding `nscAvailable`/`nscCharacterId` should not break anything; this step just confirms that).

- [ ] **Step 8: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js tests/integration/registrations.test.js
git commit -m "feat: decouple GSC from con_role, make nsc character optional, add nsc_available bolt-on"
```

---

## Task 4: Frontend — registration form redesign

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `POST /events/:id/register` and the registration shape from `GET /registrations` (Task 3): `conRole`, `characterId`, `nscAvailable`, `nscCharacterId`.
- Produces: the redesigned form's DOM ids (`registration-mode-select`, `character-select-wrap`, `character-select`, `nsc-available-toggle`, `nsc-character-wrap`, `nsc-character-select`) that Task 6 (NSC menu visibility) builds on.

- [ ] **Step 1: Replace the registration form markup**

In `frontend/account.html`, replace:

```html
              <select id="con-role-select">
                <option value="sc">SC</option>
                <option value="nsc">NSC</option>
                <option value="gsc">GSC</option>
                <option value="helfer">Helfer</option>
                <option value="orga" data-staff-only>Orga</option>
                <option value="hilfs_orga" data-staff-only>Hilfs-Orga</option>
              </select>
              <label for="con-role-select">Rolle</label>

              <div id="character-select-wrap">
                <select id="character-select"></select>
                <label for="character-select">Charakter</label>
                <p id="no-character-hint" style="display:none;">Du hast noch keinen passenden Charakter. <button
                    type="button" id="no-character-hint-btn">Charakter anlegen</button></p>
              </div>
```

with:

```html
              <select id="registration-mode-select">
                <option value="character">Charakter</option>
                <option value="helfer">Helfer</option>
                <option value="orga" data-staff-only>Orga</option>
                <option value="hilfs_orga" data-staff-only>Hilfs-Orga</option>
              </select>
              <label for="registration-mode-select">Wie kommst du?</label>

              <div id="character-select-wrap">
                <select id="character-select"></select>
                <label for="character-select">Als welcher Charakter kommst du?</label>
                <p id="no-character-hint" style="display:none;">Du hast noch keinen passenden Charakter. <button
                    type="button" id="no-character-hint-btn">Charakter anlegen</button></p>

                <label><input type="checkbox" id="nsc-available-toggle"> Ich stehe zusätzlich als NSC zur
                  Verfügung</label>

                <div id="nsc-character-wrap" style="display:none;">
                  <select id="nsc-character-select"></select>
                  <label for="nsc-character-select">NSC-Charakter (optional)</label>
                </div>
              </div>
```

- [ ] **Step 2: Replace the CON_ROLE_LABELS constant**

Replace:

```javascript
    const CON_ROLE_LABELS = {
      sc: "SC",
      nsc: "NSC",
      gsc: "GSC",
      helfer: "Helfer",
      orga: "Orga",
      hilfs_orga: "Hilfs-Orga",
    };
```

with:

```javascript
    const CON_ROLE_LABELS = {
      sc: "SC",
      nsc: "NSC",
      helfer: "Helfer",
      orga: "Orga",
      hilfs_orga: "Hilfs-Orga",
    };
```

- [ ] **Step 3: Replace the element lookups and character-selection logic**

Replace:

```javascript
    const registrationListBody = document.querySelector("#registration-list tbody");
    const registrationForm = document.getElementById("registration-form");
    attachLiveValidation(registrationForm);
    const eventSelect = document.getElementById("event-select");
    const conRoleSelect = document.getElementById("con-role-select");
    const characterSelectWrap = document.getElementById("character-select-wrap");
    const characterSelect = document.getElementById("character-select");
    const noCharacterHint = document.getElementById("no-character-hint");
    const registerButton = document.getElementById("register-button");
    const registrationMessage = document.getElementById("registration-message");
    const otFieldsContainer = document.getElementById("ot-fields");
```

with:

```javascript
    const registrationListBody = document.querySelector("#registration-list tbody");
    const registrationForm = document.getElementById("registration-form");
    attachLiveValidation(registrationForm);
    const eventSelect = document.getElementById("event-select");
    const registrationModeSelect = document.getElementById("registration-mode-select");
    const characterSelectWrap = document.getElementById("character-select-wrap");
    const characterSelect = document.getElementById("character-select");
    const noCharacterHint = document.getElementById("no-character-hint");
    const nscAvailableToggle = document.getElementById("nsc-available-toggle");
    const nscCharacterWrap = document.getElementById("nsc-character-wrap");
    const nscCharacterSelect = document.getElementById("nsc-character-select");
    const registerButton = document.getElementById("register-button");
    const registrationMessage = document.getElementById("registration-message");
    const otFieldsContainer = document.getElementById("ot-fields");
```

Replace:

```javascript
    function classForConRole(conRole) {
      return conRole === "nsc" ? "nsc" : "sc";
    }

    function populateCharacterOptions() {
      const conRole = conRoleSelect.value;
      const needsCharacter = ["sc", "gsc", "nsc"].includes(conRole);
      characterSelectWrap.style.display = needsCharacter ? "" : "none";
      if (!needsCharacter) return;
      const expectedClass = classForConRole(conRole);
      const matching = characters.filter((c) => {
        if (c.class !== expectedClass) return false;
        if (expectedClass === "sc" && c.registeredFor) return false;
        return true;
      });
      characterSelect.innerHTML = matching
        .map(
          (c) =>
            `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`,
        )
        .join("");
      noCharacterHint.style.display = matching.length === 0 ? "" : "none";
    }

    conRoleSelect.addEventListener("change", populateCharacterOptions);
    eventSelect.addEventListener("change", updateRegisterButtonLabel);
```

with:

```javascript
    function updateRegistrationModeVisibility() {
      characterSelectWrap.style.display = registrationModeSelect.value === "character" ? "" : "none";
    }

    function updateNscCharacterWrapVisibility() {
      nscCharacterWrap.style.display = nscAvailableToggle.checked ? "" : "none";
    }

    function populateRegistrationCharacterFields() {
      const matchingSc = characters.filter((c) => c.class === "sc" && !c.registeredFor);
      characterSelect.innerHTML = ['<option value="">Kein SC-Charakter</option>']
        .concat(
          matchingSc.map(
            (c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`,
          ),
        )
        .join("");
      noCharacterHint.style.display = matchingSc.length === 0 ? "" : "none";

      const matchingNsc = characters.filter((c) => c.class === "nsc");
      nscCharacterSelect.innerHTML = ['<option value="">Kein bestimmter NSC-Charakter</option>']
        .concat(
          matchingNsc.map(
            (c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`,
          ),
        )
        .join("");

      updateRegistrationModeVisibility();
      updateNscCharacterWrapVisibility();
    }

    registrationModeSelect.addEventListener("change", updateRegistrationModeVisibility);
    nscAvailableToggle.addEventListener("change", updateNscCharacterWrapVisibility);
    eventSelect.addEventListener("change", updateRegisterButtonLabel);
```

Update `loadCharacters` (replace the `populateCharacterOptions();` call):

```javascript
    async function loadCharacters() {
      characters = await api.get("/characters");
      populateRegistrationCharacterFields();
      renderCharacterList();
      renderDashboardCharacters();
    }
```

- [ ] **Step 4: Replace the submit handler**

Replace:

```javascript
    registrationForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      registrationMessage.textContent = "";
      registrationMessage.className = "";
      const eventId = eventSelect.value;
      const conRole = conRoleSelect.value;
      const needsCharacter = ["sc", "gsc", "nsc"].includes(conRole);
      const characterId = needsCharacter ? characterSelect.value : undefined;
      if (needsCharacter && !characterId) return;

      try {
        await api.post(`/events/${eventId}/register`, {
          conRole,
          characterId,
          otFields: collectOtFields(),
        });
        registrationMessage.textContent = "Angemeldet.";
        registrationMessage.className = "success";
        renderOtFields();
        await loadRegistrations();
        await loadCharacters();
      } catch (err) {
        registrationMessage.textContent =
          err.status === 400 && err.body?.details
            ? err.body.details.join(", ")
            : err.message;
        registrationMessage.className = "error";
      }
    });
```

with:

```javascript
    registrationForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      registrationMessage.textContent = "";
      registrationMessage.className = "";
      const eventId = eventSelect.value;
      const mode = registrationModeSelect.value;

      let conRole, characterId, nscAvailable, nscCharacterId;
      if (mode === "character") {
        characterId = characterSelect.value || undefined;
        nscAvailable = nscAvailableToggle.checked;
        nscCharacterId = nscAvailable ? nscCharacterSelect.value || undefined : undefined;
        conRole = characterId ? "sc" : "nsc";
        if (!characterId && !nscAvailable) {
          registrationMessage.textContent = "Wähle einen Charakter oder aktiviere die NSC-Verfügbarkeit.";
          registrationMessage.className = "error";
          return;
        }
      } else {
        conRole = mode;
        characterId = undefined;
        nscAvailable = false;
        nscCharacterId = undefined;
      }

      try {
        await api.post(`/events/${eventId}/register`, {
          conRole,
          characterId,
          nscAvailable,
          nscCharacterId,
          otFields: collectOtFields(),
        });
        registrationMessage.textContent = "Angemeldet.";
        registrationMessage.className = "success";
        renderOtFields();
        await loadRegistrations();
        updateNscMenuVisibility();
        await loadCharacters();
      } catch (err) {
        registrationMessage.textContent =
          err.status === 400 && err.body?.details
            ? err.body.details.join(", ")
            : err.message;
        registrationMessage.className = "error";
      }
    });
```

(`updateNscMenuVisibility` is added in Task 6; this line will start working once that task lands. Leaving the call in now is fine — `updateNscMenuVisibility` is a plain function declaration, hoisted, so this is not a forward-reference error, and Task 6 lands before this is manually re-tested end-to-end.)

- [ ] **Step 5: Update the "Meine Anmeldungen" table to show the NSC-available badge**

In `loadRegistrations`, replace:

```javascript
      registrationListBody.innerHTML = registrations
        .map((r) => {
          const label = STATUS_LABELS[r.status] ?? r.status;
          return `<tr>
    <td>${escapeHtml(r.eventName)}</td>
    <td>${escapeHtml(CON_ROLE_LABELS[r.conRole] ?? r.conRole)}</td>
    <td><span class="status-pill status-${escapeHtml(r.status)}">${escapeHtml(label)}</span></td>
    <td>
      <button type="button" data-edit-ot="${r.eventId}">Bearbeiten</button>
      ${r.status === "pending" ? `<button type="button" data-unregister="${r.eventId}">Abmelden</button>` : ""}
    </td>
  </tr>`;
        })
        .join("");
```

with:

```javascript
      registrationListBody.innerHTML = registrations
        .map((r) => {
          const label = STATUS_LABELS[r.status] ?? r.status;
          const roleCell = r.nscAvailable
            ? `${escapeHtml(CON_ROLE_LABELS[r.conRole] ?? r.conRole)} <span class="tag">auch NSC-bereit</span>`
            : escapeHtml(CON_ROLE_LABELS[r.conRole] ?? r.conRole);
          return `<tr>
    <td>${escapeHtml(r.eventName)}</td>
    <td>${roleCell}</td>
    <td><span class="status-pill status-${escapeHtml(r.status)}">${escapeHtml(label)}</span></td>
    <td>
      <button type="button" data-edit-ot="${r.eventId}">Bearbeiten</button>
      ${r.status === "pending" ? `<button type="button" data-unregister="${r.eventId}">Abmelden</button>` : ""}
    </td>
  </tr>`;
        })
        .join("");
```

- [ ] **Step 6: Update the staff-only option removal selector**

Replace:

```javascript
      if (!isModeratorOrAdmin) {
        document
          .querySelectorAll("#con-role-select option[data-staff-only]")
          .forEach((opt) => opt.remove());
      }
```

with:

```javascript
      if (!isModeratorOrAdmin) {
        document
          .querySelectorAll("#registration-mode-select option[data-staff-only]")
          .forEach((opt) => opt.remove());
      }
```

- [ ] **Step 7: Commit**

```bash
git add frontend/account.html
git commit -m "feat: character-first registration form with an nsc-availability toggle"
```

(No automated frontend test exists in this repo for form interaction — Task 8's manual browser verification covers this.)

---

## Task 5: Frontend — GSC checkbox on the SC character form

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `POST /characters` / `PUT /characters/:id` accepting `isGsc`, and character objects containing `is_gsc` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the checkbox to the SC character form**

In `frontend/account.html`, replace:

```html
                <form id="character-form">
                  <input id="character-name" name="name" type="text" required>
                  <label for="character-name">Charaktername</label>
                  <div id="character-dynamic-fields"></div>
                  <button type="submit">Speichern</button>
                  <button type="button" id="character-cancel-edit" style="display:none;"
                    class="btn-ghost">Abbrechen</button>
                </form>
```

with:

```html
                <form id="character-form">
                  <input id="character-name" name="name" type="text" required>
                  <label for="character-name">Charaktername</label>
                  <label><input type="checkbox" id="character-is-gsc"> GSC (Gildensprecher-Charakter)</label>
                  <div id="character-dynamic-fields"></div>
                  <button type="submit">Speichern</button>
                  <button type="button" id="character-cancel-edit" style="display:none;"
                    class="btn-ghost">Abbrechen</button>
                </form>
```

- [ ] **Step 2: Wire the checkbox into create/edit/reset/tags**

Replace the `characterForm.addEventListener("submit", ...)` handler's body (only the `data`/payload lines change):

```javascript
    characterForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      characterMessage.textContent = "";
      characterMessage.className = "";
      const name = characterForm.elements.name.value;
      const data = collectFieldValues(characterForm, scSchema);
      const isGsc = document.getElementById("character-is-gsc").checked;
      try {
        if (editingCharacterId) {
          await api.put(`/characters/${editingCharacterId}`, { name, data, isGsc });
        } else {
          await api.post("/characters", { class: "sc", name, data, isGsc });
        }
        characterMessage.textContent = "Gespeichert.";
        characterMessage.className = "success";
        resetCharacterForm();
        await loadCharacters();
      } catch (err) {
        characterMessage.textContent =
          err.status === 400 && err.body?.details
            ? err.body.details.join(", ")
            : err.message;
        characterMessage.className = "error";
      }
    });
```

Replace `startEdit`:

```javascript
    function startEdit(characterId) {
      const character = characters.find((c) => c.id === characterId);
      if (!character) return;
      editingCharacterId = characterId;
      characterFormTitle.textContent = `Charakter bearbeiten: ${character.name}`;
      characterForm.elements.name.value = character.name;
      document.getElementById("character-is-gsc").checked = character.is_gsc ?? false;
      renderScSchemaFields(character.data);
      characterForm.querySelector('button[type="submit"]').textContent =
        "Änderungen speichern";
      characterCancelButton.style.display = "";
    }
```

Replace `resetCharacterForm`:

```javascript
    function resetCharacterForm() {
      editingCharacterId = null;
      characterFormTitle.textContent = "Neuen Charakter anlegen";
      characterForm.reset();
      document.getElementById("character-is-gsc").checked = false;
      renderScSchemaFields();
      characterForm.querySelector('button[type="submit"]').textContent =
        "Speichern";
      characterCancelButton.style.display = "none";
    }
```

(`characterForm.reset()` would already uncheck a plain checkbox, but it is set explicitly here for clarity and because the copy-character flow below calls `resetCharacterForm()` and depends on this checkbox ending up unchecked.)

Replace `tagsForCharacter`:

```javascript
    function tagsForCharacter(c) {
      const dataTags = Object.entries(c.data ?? {})
        .map(([key, value]) => ({
          key,
          value: tagValueForField(
            {
              type:
                typeof value === "boolean"
                  ? "boolean"
                  : Array.isArray(value)
                    ? "multiselect"
                    : "text",
            },
            value,
          ),
        }))
        .filter(({ value }) => value !== undefined)
        .map(
          ({ key, value }) =>
            `<span class="tag">${escapeHtml(key)}: ${escapeHtml(value)}</span>`,
        )
        .join("");
      return c.is_gsc ? `<span class="tag">GSC</span>${dataTags}` : dataTags;
    }
```

- [ ] **Step 3: Commit**

```bash
git add frontend/account.html
git commit -m "feat: add GSC checkbox to the SC character form"
```

---

## Task 6: Frontend — NSC menu visibility gating

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `currentRegistrations` entries with `conRole`/`nscAvailable` (Task 3); the `nsc-tab-btn`/`nsc-section` elements that already exist.
- Produces: `updateNscMenuVisibility()`, called from Task 4's submit handler and from the page's initial load sequence below.

- [ ] **Step 1: Track whether the NSC schema loaded, and add the visibility function**

Replace:

```javascript
    let scSchema = [];
    let nscSchema = [];
    let nscCharacters = [];
    let editingNscCharacterId = null;
```

with:

```javascript
    let scSchema = [];
    let nscSchema = [];
    let nscSchemaAvailable = false;
    let nscCharacters = [];
    let editingNscCharacterId = null;
```

Then, directly below the existing declaration:

```javascript
    const nscTabButton = document.getElementById("nsc-tab-btn");
```

add:

```javascript

    // The NSC-Charaktere tab/section is only useful to someone who has
    // actually said they're available as NSC somewhere -- shown only once
    // both the schema loaded successfully AND at least one current
    // registration qualifies (con_role='nsc', or the sc-bolt-on
    // nsc_available=true). Called after loadRegistrations() populates
    // currentRegistrations, and again after the registration form submits.
    function updateNscMenuVisibility() {
      const wantsNsc =
        nscSchemaAvailable &&
        currentRegistrations.some((r) => r.conRole === "nsc" || r.nscAvailable);
      nscSection.style.display = wantsNsc ? "" : "none";
      nscTabButton.style.display = wantsNsc ? "" : "none";
    }
```

- [ ] **Step 2: Stop revealing the NSC section directly from the schema fetch**

Replace:

```javascript
      try {
        nscSchema = await api.get("/nsc-schema");
        nscSection.style.display = "";
        nscTabButton.style.display = "";
        renderNscSchemaFields();
      } catch {
        // NSC schema is optional-ish for this bootstrap: leave the NSC tab button
        // hidden (its pre-fetch default state) rather than aborting the rest of
        // the Veranstaltung tab's data load over an NSC-schema-only failure.
      }
```

with:

```javascript
      try {
        nscSchema = await api.get("/nsc-schema");
        nscSchemaAvailable = true;
        renderNscSchemaFields();
      } catch {
        // NSC schema is optional-ish for this bootstrap: leave the NSC tab button
        // hidden (its pre-fetch default state) rather than aborting the rest of
        // the Veranstaltung tab's data load over an NSC-schema-only failure.
      }
```

- [ ] **Step 3: Reorder the init sequence so registrations load before characters**

Replace:

```javascript
      await loadEvents();
      await loadCharacters();
      await loadRegistrations();
      await loadQrCode(account, events, currentRegistrations);
      renderEventBadge(events);
```

with:

```javascript
      await loadEvents();
      await loadRegistrations();
      updateNscMenuVisibility();
      await loadCharacters();
      await loadQrCode(account, events, currentRegistrations);
      renderEventBadge(events);
```

(`renderCharacterList()`, called from `loadCharacters()`, checks `nscSection.style.display` to decide whether to also render the NSC character list -- it must run after `updateNscMenuVisibility()` has set that style, not before. Neither `loadRegistrations()` nor `renderDashboardEventCard()` depend on `characters` being loaded first, so this reordering is safe.)

- [ ] **Step 4: Commit**

```bash
git add frontend/account.html
git commit -m "feat: gate the NSC-Charaktere menu on actual nsc availability"
```

---

## Task 7: Frontend — admin check-in NSC-available indicator

**Files:**
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `nscAvailable` field on participant/scan-lookup objects (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Drop `gsc` from the label map**

Replace:

```javascript
const CON_ROLE_LABELS = { sc: 'SC', nsc: 'NSC', gsc: 'GSC', helfer: 'Helfer', orga: 'Orga', hilfs_orga: 'Hilfs-Orga' };
```

with:

```javascript
const CON_ROLE_LABELS = { sc: 'SC', nsc: 'NSC', helfer: 'Helfer', orga: 'Orga', hilfs_orga: 'Hilfs-Orga' };
```

- [ ] **Step 2: Show the badge in the participant list**

Replace:

```javascript
function renderConRoleCell(p) {
  const label = CON_ROLE_LABELS[p.conRole] ?? p.conRole ?? '–';
  if (!canOverride || !p.userId || !['helfer', 'orga', 'hilfs_orga'].includes(p.conRole)) {
    return escapeHtml(label);
  }
  const options = ['helfer', 'hilfs_orga', 'orga'].map((r) => `<option value="${r}" ${r === p.conRole ? 'selected' : ''}>${CON_ROLE_LABELS[r]}</option>`).join('');
  return `<select data-con-role="${escapeHtml(p.userId)}" aria-label="Rolle ändern">${options}</select>`;
}
```

with:

```javascript
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

- [ ] **Step 3: Show it in the scan dialog too**

Replace:

```javascript
  document.getElementById('scan-group').textContent = `Kategorie: ${CON_ROLE_LABELS[lookup.conRole] ?? lookup.conRole}`;
```

with:

```javascript
  document.getElementById('scan-group').textContent = `Kategorie: ${CON_ROLE_LABELS[lookup.conRole] ?? lookup.conRole}${lookup.nscAvailable ? ' (auch NSC-bereit)' : ''}`;
```

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/checkin.html
git commit -m "feat: show NSC-availability badge in check-in participant list and scan dialog"
```

---

## Task 8: Full verification pass

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full automated test suite**

Run:
```bash
TEST_DATABASE_URL="postgres://app:app@localhost:5433/pakyrion_test" ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" npm test
```
Expected: every test passes (no `not ok` lines, `# fail 0`).

- [ ] **Step 2: Manually verify the registration form in the browser**

Start the app (`docker compose -f docker-compose.dev.yml up`, or reuse the already-running dev container), open `/account.html#veranstaltung`, and check:
- Selecting an SC character and submitting registers as `sc`.
- Leaving "Kein SC-Charakter" and enabling "Ich stehe zusätzlich als NSC zur Verfügung" registers as `nsc`.
- Selecting an SC character AND enabling the NSC toggle registers as `sc` with the "auch NSC-bereit" badge showing in "Meine Anmeldungen".
- Choosing "Helfer" hides the character/NSC block entirely and registers as `helfer`.
- After registering with the NSC toggle on, the "NSC-Charaktere" tab under "Charaktere" becomes visible; it stays hidden for a plain `sc`-only registration.

- [ ] **Step 3: Manually verify the GSC checkbox**

On the "Charaktere" tab, create or edit an SC character, check "GSC", save, and confirm the character card shows a "GSC" tag.

- [ ] **Step 4: Commit any fixes found during manual verification**

If manual verification finds a bug, fix it, re-run the relevant automated tests, and commit with a message describing the fix. If everything already works, no commit is needed for this task.
