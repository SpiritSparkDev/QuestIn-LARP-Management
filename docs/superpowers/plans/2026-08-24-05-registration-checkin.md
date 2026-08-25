# Registration & Check-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Participants register/unregister themselves for an event; admins and check-in helpers see a per-event participant list (name, characters, status — no encrypted fields) and check people in/out through an explicit `registered → checked_in → checked_out` state machine.

**Architecture:** One `registrations` table (`user_id`+`event_id` primary key, matching the spec exactly), a pure status-machine function (`backend/registrations/statusMachine.js`, unit-tested per the spec's explicit requirement), and one route module split across two tasks: participant self-service (register/unregister) and staff-facing (participant list, check-in, check-out). The participant list never selects the `*_enc` columns at all — `checkin_helper`'s lack of access to sensitive fields is structural, not a runtime filter.

**Tech Stack:** No new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-24-teilnehmerregistrierung-design.md](../specs/2026-08-24-teilnehmerregistrierung-design.md)

**Builds on:** [2026-08-24-01-foundation.md](2026-08-24-01-foundation.md), [2026-08-24-02-auth-core.md](2026-08-24-02-auth-core.md), [2026-08-24-04-events-characters.md](2026-08-24-04-events-characters.md) (all merged) — reuses `router`/`db`/`logger`, `requireAuth`/`requireRole`, `readJsonBody`, `getEvent`.

## Resolved design questions (carried over from Plan 4's final review)

- **Does a registration reference a specific character?** No — the spec's `registrations` table (`user_id`, `event_id`, `status`, `checked_in_at`, `checked_out_at`, PK on `(user_id, event_id)`) has no `character_id` column. Registration is per person per event; a participant may have zero, one, or several characters for that event independently of their registration status. The participant list (Task 4) shows all of a user's characters for the event alongside their registration status — that's the join, not a foreign key.
- **Can admin/checkin_helper list all characters/participants for an event?** Not yet — Plan 4 only built "list my own characters." This plan adds `GET /events/:id/participants` (Task 4), which is the missing piece.

## Global Constraints

- Keine ORM — rohes, parametrisiertes SQL über `pg`.
- `registrations` PK `(user_id, event_id)` — ein Teilnehmer hat höchstens eine Registrierung pro Event.
- Status-Maschine exakt `registered → checked_in → checked_out`; ungültige Übergänge (z.B. Check-Out ohne Check-In, doppeltes Check-In) sind ein Fehler — als eigene, unit-testbare Funktion (Spec's Testing-Sektion verlangt das explizit).
- `checkin_helper` bekommt beim Teilnehmerliste-Abruf keine verschlüsselten Felder (`*_enc`) — das SQL selektiert diese Spalten dort gar nicht erst.
- `participant`: sich zu Events an-/abmelden. `checkin_helper`/`admin`: Teilnehmerliste sehen, Check-In/Check-Out. Rolle wird serverseitig bei jedem Request geprüft.
- Route-Module registrieren sich via `router` aus `backend/routes.js`, nicht aus `backend/server.js`.
- Kein Test-Framework-Dependency — `node:test`.

---

### Task 1: `registrations` schema migration

**Files:**
- Create: `db/migrations/004_registrations.sql`
- Test: `tests/integration/schema-registrations.test.js`

**Interfaces:**
- Consumes: `runMigrations` from `db/migrate.js`
- Produces: table `registrations`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/schema-registrations.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { query, closePool } = await import('../../backend/db.js');

async function makeUser() {
  const { rows } = await query(
    "INSERT INTO users (email, name, role) VALUES ($1, 'Reg Test', 'participant') RETURNING id",
    [`reg-schema-${crypto.randomUUID()}@example.com`]
  );
  return rows[0].id;
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Reg Schema Con', '2027-06-01') RETURNING id"
  );
  return rows[0].id;
}

test('registrations table exists after migration', async () => {
  const { rows } = await query("SELECT to_regclass('registrations') AS exists");
  assert.ok(rows[0].exists);
});

test('a user can register for an event at most once (primary key enforced)', async () => {
  const userId = await makeUser();
  const eventId = await makeEvent();
  await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [userId, eventId]);
  await assert.rejects(
    query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [userId, eventId]),
    /duplicate key value violates/
  );
});

test('status must be one of the allowed values', async () => {
  const userId = await makeUser();
  const eventId = await makeEvent();
  await assert.rejects(
    query(
      "INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'not-a-real-status')",
      [userId, eventId]
    ),
    /violates check constraint/
  );
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker compose up -d db-test
node --test tests/integration/schema-registrations.test.js
```

Expected: FAIL — table doesn't exist yet.

- [ ] **Step 3: Write the migration**

Create `db/migrations/004_registrations.sql`:

```sql
CREATE TABLE registrations (
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  status text not null default 'registered' check (status in ('registered', 'checked_in', 'checked_out')),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  primary key (user_id, event_id)
);

CREATE INDEX registrations_event_id_idx ON registrations (event_id);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/integration/schema-registrations.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/004_registrations.sql tests/integration/schema-registrations.test.js
git commit -m "feat: registrations schema migration"
```

---

### Task 2: Check-in/out status machine

**Files:**
- Create: `backend/registrations/statusMachine.js`
- Test: `tests/unit/statusMachine.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `export function applyTransition(currentStatus, action)` → next status string, or throws `Error` with `err.code = 'INVALID_TRANSITION'`. `action` is `'checkin' | 'checkout'`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/statusMachine.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransition } from '../../backend/registrations/statusMachine.js';

test('registered -> checked_in via checkin', () => {
  assert.equal(applyTransition('registered', 'checkin'), 'checked_in');
});

test('checked_in -> checked_out via checkout', () => {
  assert.equal(applyTransition('checked_in', 'checkout'), 'checked_out');
});

test('checkout without a prior checkin is rejected', () => {
  assert.throws(() => applyTransition('registered', 'checkout'), /INVALID_TRANSITION|invalid transition/);
});

test('a second checkin is rejected', () => {
  assert.throws(() => applyTransition('checked_in', 'checkin'));
});

test('any transition from checked_out is rejected', () => {
  assert.throws(() => applyTransition('checked_out', 'checkin'));
  assert.throws(() => applyTransition('checked_out', 'checkout'));
});

test('the thrown error carries a machine-readable code', () => {
  try {
    applyTransition('registered', 'checkout');
    assert.fail('expected a throw');
  } catch (err) {
    assert.equal(err.code, 'INVALID_TRANSITION');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/unit/statusMachine.test.js
```

Expected: FAIL — `Cannot find module '../../backend/registrations/statusMachine.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/registrations/statusMachine.js`:

```js
const TRANSITIONS = {
  registered: { checkin: 'checked_in' },
  checked_in: { checkout: 'checked_out' },
  checked_out: {},
};

export function applyTransition(currentStatus, action) {
  const next = TRANSITIONS[currentStatus]?.[action];
  if (!next) {
    const err = new Error(`invalid transition: cannot ${action} from status "${currentStatus}"`);
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/unit/statusMachine.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/registrations/statusMachine.js tests/unit/statusMachine.test.js
git commit -m "feat: check-in/out status machine"
```

---

### Task 3: Registration (participant self-service)

**Files:**
- Create: `backend/registrations/repository.js`
- Create: `backend/registrations/routes.js`
- Modify: `backend/server.js` (import `./registrations/routes.js`)
- Test: `tests/integration/registrations.test.js`

**Interfaces:**
- Consumes: `query` from `backend/db.js`; `getEvent` from `backend/events/repository.js`; `requireAuth` from `backend/middleware/authenticate.js`; `router` from `backend/routes.js`
- Produces: `export async function registerForEvent(userId, eventId)` → registration row (throws `EVENT_NOT_FOUND` or `ALREADY_REGISTERED`), `export async function unregisterFromEvent(userId, eventId)` (throws `REGISTRATION_NOT_FOUND` or `CANNOT_UNREGISTER`). Registers `POST /events/:id/register` and `DELETE /events/:id/register`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/registrations.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { createServer } = await import('../../backend/server.js');
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession() {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Reg Test', 'participant', true) RETURNING id",
    [`reg-${crypto.randomUUID()}@example.com`]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Reg Test Con', '2027-08-01') RETURNING id"
  );
  return rows[0].id;
}

test('a participant can register and unregister for an event', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { userId, cookie } = await makeUserAndSession();
  const eventId = await makeEvent();

  const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(registerRes.status, 201);
  const registration = await registerRes.json();
  assert.equal(registration.status, 'registered');

  const dupRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(dupRes.status, 409);

  const unregisterRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(unregisterRes.status, 200);

  const { rows } = await query(
    'SELECT * FROM registrations WHERE user_id = $1 AND event_id = $2',
    [userId, eventId]
  );
  assert.equal(rows.length, 0);

  server.close();
});

test('registering for an unknown event returns 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { cookie } = await makeUserAndSession();

  const res = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(res.status, 404);

  server.close();
});

test('unregistering without an existing registration returns 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { cookie } = await makeUserAndSession();
  const eventId = await makeEvent();

  const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(res.status, 404);

  server.close();
});

test('a checked-in participant cannot unregister', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { userId, cookie } = await makeUserAndSession();
  const eventId = await makeEvent();

  await query(
    "INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'checked_in')",
    [userId, eventId]
  );

  const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(res.status, 409);

  server.close();
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/integration/registrations.test.js
```

Expected: FAIL — `Cannot find module '../../backend/registrations/repository.js'`.

- [ ] **Step 3: Write `backend/registrations/repository.js`**

```js
import { query } from '../db.js';
import { getEvent } from '../events/repository.js';

export async function registerForEvent(userId, eventId) {
  const event = await getEvent(eventId);
  if (!event) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id)
       VALUES ($1, $2)
       RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
      [userId, eventId]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('already registered for this event');
      dup.code = 'ALREADY_REGISTERED';
      throw dup;
    }
    throw err;
  }
}

export async function unregisterFromEvent(userId, eventId) {
  const { rows } = await query(
    'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
    [userId, eventId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  if (rows[0].status !== 'registered') {
    const err = new Error('cannot unregister after check-in');
    err.code = 'CANNOT_UNREGISTER';
    throw err;
  }
  await query('DELETE FROM registrations WHERE user_id = $1 AND event_id = $2', [userId, eventId]);
}
```

- [ ] **Step 4: Write `backend/registrations/routes.js`**

```js
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { registerForEvent, unregisterFromEvent } from './repository.js';

router.post('/events/:id/register', requireAuth(async ({ params, user }) => {
  try {
    const registration = await registerForEvent(user.id, params.id);
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/events/:id/register', requireAuth(async ({ params, user }) => {
  try {
    await unregisterFromEvent(user.id, params.id);
    return { status: 200, body: { unregistered: true } };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'CANNOT_UNREGISTER') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));
```

- [ ] **Step 5: Wire it into the server entry point**

Read `backend/server.js` and add:

```js
import './registrations/routes.js';
```

- [ ] **Step 6: Run test to verify it passes**

```bash
node --test tests/integration/registrations.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js backend/server.js tests/integration/registrations.test.js
git commit -m "feat: event registration (participant self-service)"
```

---

### Task 4: Participant list + check-in/check-out (admin, checkin_helper)

**Files:**
- Modify: `backend/registrations/repository.js` (add `listParticipantsForEvent`, `checkIn`, `checkOut`)
- Modify: `backend/registrations/routes.js` (register `GET /events/:id/participants`, `POST /events/:id/checkin`, `POST /events/:id/checkout`)
- Test: `tests/integration/checkin.test.js`

**Interfaces:**
- Consumes: `query` from `backend/db.js`; `applyTransition` from `backend/registrations/statusMachine.js`; `requireAuth`/`requireRole` from `backend/middleware/*`; `readJsonBody` from `backend/httpBody.js`
- Produces: `export async function listParticipantsForEvent(eventId)` → `[{ userId, name, status, checkedInAt, checkedOutAt, characters: [{id, name}] }]` (never selects `*_enc` columns), `export async function checkIn(eventId, userId)`, `export async function checkOut(eventId, userId)` (both throw `REGISTRATION_NOT_FOUND` or `INVALID_TRANSITION`). Registers `GET /events/:id/participants`, `POST /events/:id/checkin`, `POST /events/:id/checkout` — all three behind `requireAuth(requireRole('admin', 'checkin_helper')(...))`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/checkin.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { createServer } = await import('../../backend/server.js');
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(role = 'participant') {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Checkin Test', $2, true) RETURNING id",
    [`checkin-${role}-${crypto.randomUUID()}@example.com`, role]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Checkin Test Con', '2027-09-01') RETURNING id"
  );
  return rows[0].id;
}

test('a participant cannot list participants or check anyone in', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { cookie } = await makeUserAndSession('participant');
  const eventId = await makeEvent();

  const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: cookie } });
  assert.equal(listRes.status, 403);

  const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ userId: crypto.randomUUID() }),
  });
  assert.equal(checkinRes.status, 403);

  server.close();
});

test('checkin_helper sees the participant list with characters and no encrypted fields, then checks someone in and out', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const helper = await makeUserAndSession('checkin_helper');
  const attendee = await makeUserAndSession('participant');
  const eventId = await makeEvent();

  await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);
  await query(
    "INSERT INTO characters (user_id, event_id, name, data) VALUES ($1, $2, 'Aldric', '{}')",
    [attendee.userId, eventId]
  );

  const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: helper.cookie } });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  const entry = list.find((p) => p.userId === attendee.userId);
  assert.ok(entry);
  assert.equal(entry.status, 'registered');
  assert.deepEqual(entry.characters.map((c) => c.name), ['Aldric']);
  assert.equal(JSON.stringify(entry).includes('_enc'), false);
  assert.equal('address' in entry, false);

  const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: attendee.userId }),
  });
  assert.equal(checkinRes.status, 200);
  assert.equal((await checkinRes.json()).status, 'checked_in');

  const doubleCheckinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: attendee.userId }),
  });
  assert.equal(doubleCheckinRes.status, 409);

  const checkoutRes = await fetch(`http://localhost:${port}/events/${eventId}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: attendee.userId }),
  });
  assert.equal(checkoutRes.status, 200);
  assert.equal((await checkoutRes.json()).status, 'checked_out');

  server.close();
});

test('checking in a user with no registration for the event returns 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const helper = await makeUserAndSession('checkin_helper');
  const stranger = await makeUserAndSession('participant');
  const eventId = await makeEvent();

  const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: stranger.userId }),
  });
  assert.equal(res.status, 404);

  server.close();
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/integration/checkin.test.js
```

Expected: FAIL — `GET /events/:id/participants` doesn't exist yet (404 where the test expects 403, or the handler functions aren't exported).

- [ ] **Step 3: Extend `backend/registrations/repository.js`**

Read the current file (from Task 3) and append:

```js
import { applyTransition } from './statusMachine.js';

export async function listParticipantsForEvent(eventId) {
  const { rows: registrations } = await query(
    `SELECT r.user_id, u.name, r.status, r.checked_in_at, r.checked_out_at
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.name`,
    [eventId]
  );
  const { rows: characters } = await query(
    'SELECT id, user_id, name FROM characters WHERE event_id = $1',
    [eventId]
  );

  const charactersByUser = new Map();
  for (const c of characters) {
    if (!charactersByUser.has(c.user_id)) charactersByUser.set(c.user_id, []);
    charactersByUser.get(c.user_id).push({ id: c.id, name: c.name });
  }

  return registrations.map((r) => ({
    userId: r.user_id,
    name: r.name,
    status: r.status,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    characters: charactersByUser.get(r.user_id) ?? [],
  }));
}

async function transitionStatus(eventId, userId, action) {
  const { rows } = await query(
    'SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }

  const nextStatus = applyTransition(rows[0].status, action);
  const timestampColumn = action === 'checkin' ? 'checked_in_at' : 'checked_out_at';
  const { rows: updated } = await query(
    `UPDATE registrations SET status = $3, ${timestampColumn} = now()
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, nextStatus]
  );
  return updated[0];
}

export async function checkIn(eventId, userId) {
  return transitionStatus(eventId, userId, 'checkin');
}

export async function checkOut(eventId, userId) {
  return transitionStatus(eventId, userId, 'checkout');
}
```

(Add the `import { applyTransition } from './statusMachine.js';` line to the existing import block at the top of the file, alongside the existing `query`/`getEvent` imports — don't duplicate the `query` import.)

- [ ] **Step 4: Extend `backend/registrations/routes.js`**

Read the current file (from Task 3) and append:

```js
import { requireRole } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listParticipantsForEvent, checkIn, checkOut } from './repository.js';

router.get('/events/:id/participants', requireAuth(requireRole('admin', 'checkin_helper')(async ({ params }) => {
  const participants = await listParticipantsForEvent(params.id);
  return { status: 200, body: participants };
})));

router.post('/events/:id/checkin', requireAuth(requireRole('admin', 'checkin_helper')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!body.userId) return { status: 400, body: { error: 'userId is required' } };
  try {
    const registration = await checkIn(params.id, body.userId);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_TRANSITION') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

router.post('/events/:id/checkout', requireAuth(requireRole('admin', 'checkin_helper')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!body.userId) return { status: 400, body: { error: 'userId is required' } };
  try {
    const registration = await checkOut(params.id, body.userId);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_TRANSITION') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));
```

(Add the `requireRole`/`readJsonBody` imports and the three new imports from `./repository.js` to the existing import block — don't duplicate `router`/`requireAuth`/`registerForEvent`/`unregisterFromEvent`.)

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test tests/integration/checkin.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Run the full test suite**

```bash
npm test
```

Expected: all tests across this plan and Plans 1, 2, 3, 4 pass.

- [ ] **Step 7: Verify the dev stack end-to-end**

```bash
docker compose up -d --build
```

As a participant, register for an event; as an admin or checkin_helper (flip a user's role directly in the DB for this manual check), fetch the participant list, check the participant in, then out. Confirm the response never contains address/birthdate/phone/emergencyContact/medicalNotes. Then:

```bash
docker compose down
```

- [ ] **Step 8: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js tests/integration/checkin.test.js
git commit -m "feat: participant list and check-in/check-out (admin, checkin_helper)"
```

---

## Self-Review Notes

- **Spec coverage**: `registrations` table matches spec exactly (PK, status enum, timestamps) ✓; `participant` can register/unregister ✓; `checkin_helper`/`admin` see the participant list (name, characters, status) with no encrypted fields ✓ (structural — the SQL never selects `*_enc`) and perform check-in/check-out ✓; status machine unit-tested per spec's explicit Testing-section requirement (`registered → checked_in → checked_out`, invalid transitions rejected) ✓; role checked server-side on every route via `requireAuth`/`requireRole` ✓.
- **Placeholder scan**: no TBD/TODO; every step has runnable code. (Task 3's Step 1 test includes one inline note flagging its own cleanup query as something to simplify when actually writing the file — not a placeholder, an explicit instruction to the implementer.)
- **Type/name consistency**: `applyTransition(currentStatus, action)` (Task 2) is called identically inside `transitionStatus` (Task 4's addition to `repository.js`) with `action` values `'checkin'`/`'checkout'` matching the route names. Error codes (`EVENT_NOT_FOUND`, `ALREADY_REGISTERED`, `REGISTRATION_NOT_FOUND`, `CANNOT_UNREGISTER`, `INVALID_TRANSITION`) are thrown and caught with the same string literals across `repository.js` and `routes.js`. `listParticipantsForEvent`'s return shape (`userId`, `name`, `status`, `checkedInAt`, `checkedOutAt`, `characters`) is exactly what `checkin.test.js` asserts against.
