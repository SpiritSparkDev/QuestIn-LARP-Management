# Events & Characters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins create events with a per-event configurable character form (JSONB schema); participants create and edit their own characters for an event, validated server-side against that event's schema.

**Architecture:** Two new tables (`events`, `characters`), a pure validation function (`backend/events/schemaValidation.js`) that checks a character's `data` object against an event's `character_form_schema`, and two route modules following the established `router`-from-`routes.js` convention. Characters carry an ownership check (only the owning participant may edit; the owner or an admin may view); events are admin-managed but readable by any authenticated user.

**Tech Stack:** Postgres `jsonb` columns, no new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-24-teilnehmerregistrierung-design.md](../specs/2026-08-24-teilnehmerregistrierung-design.md)

**Builds on:** [2026-08-24-01-foundation.md](2026-08-24-01-foundation.md), [2026-08-24-02-auth-core.md](2026-08-24-02-auth-core.md) (both merged) — reuses `router`/`db`/`logger`/`runMigrations`, `requireAuth`/`requireRole`, `readJsonBody`.

## Global Constraints

- Keine ORM — rohes, parametrisiertes SQL über `pg`.
- `character_form_schema` ist JSONB, vom Admin pro Event definiert; keine Migration nötig, um Felder zu ändern.
- Validierung (Pflichtfelder, unbekannte Felder) passiert serverseitig beim Speichern eines Charakters gegen `events.character_form_schema`.
- `participant`: eigene Charaktere anlegen/ändern. `admin`: alle Charaktere einsehen (nicht: fremde ändern), Events anlegen/Formular definieren. Die API prüft die Rolle serverseitig bei jedem Request.
- Kein Test-Framework-Dependency — `node:test`.

---

### Task 1: `events` and `characters` schema migration

**Files:**
- Create: `db/migrations/003_events_and_characters.sql`
- Test: `tests/integration/schema-events.test.js`

**Interfaces:**
- Consumes: `runMigrations` from `db/migrate.js`
- Produces: tables `events` and `characters`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/schema-events.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { query, closePool } = await import('../../backend/db.js');

test('events and characters tables exist after migration', async () => {
  for (const table of ['events', 'characters']) {
    const { rows } = await query('SELECT to_regclass($1) AS exists', [table]);
    assert.ok(rows[0].exists, `expected table "${table}" to exist`);
  }
});

test('a character requires a valid event_id and user_id (foreign keys enforced)', async () => {
  await assert.rejects(
    query(
      "INSERT INTO characters (user_id, event_id, name) VALUES (gen_random_uuid(), gen_random_uuid(), 'Ghost')"
    ),
    /violates foreign key constraint/
  );
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker compose up -d db-test
node --test tests/integration/schema-events.test.js
```

Expected: FAIL — tables don't exist yet.

- [ ] **Step 3: Write the migration**

Create `db/migrations/003_events_and_characters.sql`:

```sql
CREATE TABLE events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event_date date not null,
  character_form_schema jsonb not null default '[]',
  created_at timestamptz not null default now()
);

CREATE TABLE characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

CREATE INDEX characters_user_id_idx ON characters (user_id);
CREATE INDEX characters_event_id_idx ON characters (event_id);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/integration/schema-events.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/003_events_and_characters.sql tests/integration/schema-events.test.js
git commit -m "feat: events and characters schema migration"
```

---

### Task 2: Character form schema validation

**Files:**
- Create: `backend/events/schemaValidation.js`
- Test: `tests/unit/schemaValidation.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `export function validateCharacterData(schema, data)` → `string[]` (empty array = valid). `schema` is an array of `{ key, label, type, required }`; `data` is a plain object of `{ [key]: value }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/schemaValidation.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCharacterData } from '../../backend/events/schemaValidation.js';

const SCHEMA = [
  { key: 'fraction', label: 'Fraktion', type: 'text', required: true },
  { key: 'background', label: 'Hintergrund', type: 'textarea', required: false },
];

test('valid data passes with no errors', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: 'Nordmark', background: 'Ein Waisenkind' });
  assert.deepEqual(errors, []);
});

test('a missing required field is an error', () => {
  const errors = validateCharacterData(SCHEMA, { background: 'nur Hintergrund' });
  assert.ok(errors.some((e) => e.includes('fraction')));
});

test('an unknown field is an error', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: 'Nordmark', notInSchema: 'x' });
  assert.ok(errors.some((e) => e.includes('notInSchema')));
});

test('an empty schema with empty data is valid', () => {
  assert.deepEqual(validateCharacterData([], {}), []);
});

test('an empty string for a required field is an error', () => {
  const errors = validateCharacterData(SCHEMA, { fraction: '' });
  assert.ok(errors.some((e) => e.includes('fraction')));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/unit/schemaValidation.test.js
```

Expected: FAIL — `Cannot find module '../../backend/events/schemaValidation.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/events/schemaValidation.js`:

```js
export function validateCharacterData(schema, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['data must be an object'];
  }

  const errors = [];
  const allowedKeys = new Set(schema.map((field) => field.key));

  for (const field of schema) {
    const value = data[field.key];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.key} is required`);
    }
  }

  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/unit/schemaValidation.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/events/schemaValidation.js tests/unit/schemaValidation.test.js
git commit -m "feat: character form schema validation"
```

---

### Task 3: Events CRUD (admin-managed, readable by any authenticated user)

**Files:**
- Create: `backend/events/repository.js`
- Create: `backend/events/routes.js`
- Modify: `backend/db.js` (keep Postgres `date` columns as plain `YYYY-MM-DD` strings instead of `pg`'s default `Date` object parsing, which shifts by a day depending on local timezone)
- Modify: `backend/server.js` (import `./events/routes.js`)
- Test: `tests/integration/events.test.js`

**Interfaces:**
- Consumes: `query` from `backend/db.js`; `requireAuth` from `backend/middleware/authenticate.js`; `requireRole` from `backend/middleware/authorize.js`; `readJsonBody` from `backend/httpBody.js`; `router` from `backend/routes.js`
- Produces: `export async function createEvent({ name, eventDate, characterFormSchema })`, `export async function getEvent(id)` → event or `null`, `export async function listEvents()` → array, `export async function updateEvent(id, { name, eventDate, characterFormSchema })` → updated event or `null`. Registers `POST /events` (admin), `GET /events` (any authenticated user), `GET /events/:id` (any authenticated user), `PUT /events/:id` (admin).

- [ ] **Step 1: Fix Postgres `date` parsing in `backend/db.js`**

Read the current `backend/db.js`. Add near the top, after the `pg` import:

```js
import pg from 'pg';

// Keep DATE columns as plain 'YYYY-MM-DD' strings — pg's default Date-object
// parsing shifts the value by a day depending on the server's local timezone.
pg.types.setTypeParser(1082, (value) => value);
```

(If `backend/db.js` already does `import pg from 'pg';` followed by `const { Pool } = pg;`, just insert the `pg.types.setTypeParser(1082, (value) => value);` line and its comment right after that import, before the rest of the file.)

- [ ] **Step 2: Write the failing test**

Create `tests/integration/events.test.js`:

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

async function makeUserAndSession(role = 'participant') {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Events Test', $2, true) RETURNING id",
    [`events-${role}-${crypto.randomUUID()}@example.com`, role]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('admin can create an event; participant cannot', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const participant = await makeUserAndSession('participant');
  const payload = {
    name: 'Sommercon 2027',
    eventDate: '2027-07-15',
    characterFormSchema: [{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }],
  };

  const asAdmin = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify(payload),
  });
  assert.equal(asAdmin.status, 201);
  const created = await asAdmin.json();
  assert.equal(created.name, 'Sommercon 2027');
  assert.equal(created.event_date, '2027-07-15');

  const asParticipant = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify(payload),
  });
  assert.equal(asParticipant.status, 403);

  server.close();
});

test('any authenticated user can list and get events; unknown id is 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const participant = await makeUserAndSession('participant');

  const createRes = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Wintercon', eventDate: '2027-01-10', characterFormSchema: [] }),
  });
  const { id } = await createRes.json();

  const listRes = await fetch(`http://localhost:${port}/events`, { headers: { Cookie: participant.cookie } });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.some((e) => e.id === id));

  const getRes = await fetch(`http://localhost:${port}/events/${id}`, { headers: { Cookie: participant.cookie } });
  assert.equal(getRes.status, 200);

  const missingRes = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}`, { headers: { Cookie: participant.cookie } });
  assert.equal(missingRes.status, 404);

  server.close();
});

test('admin can update an event\'s character form schema', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');

  const createRes = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Frühlingscon', eventDate: '2027-04-01', characterFormSchema: [] }),
  });
  const { id } = await createRes.json();

  const newSchema = [{ key: 'weapon', label: 'Waffe', type: 'text', required: false }];
  const updateRes = await fetch(`http://localhost:${port}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ characterFormSchema: newSchema }),
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.deepEqual(updated.character_form_schema, newSchema);
  assert.equal(updated.name, 'Frühlingscon');

  server.close();
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
node --test tests/integration/events.test.js
```

Expected: FAIL — `Cannot find module '../../backend/events/repository.js'`.

- [ ] **Step 4: Write `backend/events/repository.js`**

```js
import { query } from '../db.js';

export async function createEvent({ name, eventDate, characterFormSchema }) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, character_form_schema)
     VALUES ($1, $2, $3)
     RETURNING id, name, event_date, character_form_schema, created_at`,
    [name, eventDate, JSON.stringify(characterFormSchema ?? [])]
  );
  return rows[0];
}

export async function getEvent(id) {
  const { rows } = await query(
    'SELECT id, name, event_date, character_form_schema, created_at FROM events WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

export async function listEvents() {
  const { rows } = await query(
    'SELECT id, name, event_date, character_form_schema, created_at FROM events ORDER BY event_date'
  );
  return rows;
}

export async function updateEvent(id, { name, eventDate, characterFormSchema }) {
  const { rows } = await query(
    `UPDATE events SET
       name = COALESCE($2, name),
       event_date = COALESCE($3, event_date),
       character_form_schema = COALESCE($4, character_form_schema)
     WHERE id = $1
     RETURNING id, name, event_date, character_form_schema, created_at`,
    [
      id,
      name ?? null,
      eventDate ?? null,
      characterFormSchema !== undefined ? JSON.stringify(characterFormSchema) : null,
    ]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 5: Write `backend/events/routes.js`**

```js
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { createEvent, getEvent, listEvents, updateEvent } from './repository.js';

router.post('/events', requireAuth(requireRole('admin')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, characterFormSchema } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  const event = await createEvent({ name, eventDate, characterFormSchema });
  return { status: 201, body: event };
})));

router.get('/events', requireAuth(async () => {
  const events = await listEvents();
  return { status: 200, body: events };
}));

router.get('/events/:id', requireAuth(async ({ params }) => {
  const event = await getEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
}));

router.put('/events/:id', requireAuth(requireRole('admin')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const event = await updateEvent(params.id, body);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));
```

- [ ] **Step 6: Wire it into the server entry point**

Read `backend/server.js` and add:

```js
import './events/routes.js';
```

- [ ] **Step 7: Run test to verify it passes**

```bash
node --test tests/integration/events.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 8: Commit**

```bash
git add backend/events/repository.js backend/events/routes.js backend/db.js backend/server.js tests/integration/events.test.js
git commit -m "feat: events crud (admin-managed, readable by any authenticated user)"
```

---

### Task 4: Characters CRUD (own characters, admin can view any)

**Files:**
- Create: `backend/characters/repository.js`
- Create: `backend/characters/routes.js`
- Modify: `backend/server.js` (import `./characters/routes.js`)
- Test: `tests/integration/characters.test.js`

**Interfaces:**
- Consumes: `query` from `backend/db.js`; `validateCharacterData` from `backend/events/schemaValidation.js`; `getEvent` from `backend/events/repository.js`; `requireAuth` from `backend/middleware/authenticate.js`; `readJsonBody` from `backend/httpBody.js`; `router` from `backend/routes.js`
- Produces: `export async function createCharacter(userId, { eventId, name, data })` (throws `{code:'EVENT_NOT_FOUND'}` or `{code:'INVALID_CHARACTER_DATA', details}`), `export async function getCharacter(id)` → character or `null`, `export async function listCharactersForUser(userId)` → array, `export async function updateCharacter(id, { name, data })` → updated character or `null` (throws `{code:'INVALID_CHARACTER_DATA', details}`). Registers `POST /characters`, `GET /characters` (own), `GET /characters/:id` (owner or admin), `PUT /characters/:id` (owner only).

- [ ] **Step 1: Write the failing test**

Create `tests/integration/characters.test.js`:

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
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Char Test', $2, true) RETURNING id",
    [`chars-${role}-${crypto.randomUUID()}@example.com`, role]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent(schema = [{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }]) {
  const { rows } = await query(
    `INSERT INTO events (name, event_date, character_form_schema)
     VALUES ('Char Test Con', '2027-05-01', $1) RETURNING id`,
    [JSON.stringify(schema)]
  );
  return rows[0].id;
}

test('creating a character validates against the event schema', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const participant = await makeUserAndSession();
  const eventId = await makeEvent();

  const missingRequired = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify({ eventId, name: 'Aldric', data: {} }),
  });
  assert.equal(missingRequired.status, 400);

  const ok = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify({ eventId, name: 'Aldric', data: { fraction: 'Nordmark' } }),
  });
  assert.equal(ok.status, 201);
  const created = await ok.json();
  assert.equal(created.name, 'Aldric');

  const unknownEvent = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify({ eventId: crypto.randomUUID(), name: 'Ghost', data: {} }),
  });
  assert.equal(unknownEvent.status, 404);

  server.close();
});

test('a participant only sees their own characters in the list', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const alice = await makeUserAndSession();
  const bob = await makeUserAndSession();
  const eventId = await makeEvent([]);

  await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
    body: JSON.stringify({ eventId, name: 'Alice Char', data: {} }),
  });
  await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
    body: JSON.stringify({ eventId, name: 'Bob Char', data: {} }),
  });

  const aliceList = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: alice.cookie } })).json();
  assert.ok(aliceList.every((c) => c.name !== 'Bob Char'));
  assert.ok(aliceList.some((c) => c.name === 'Alice Char'));

  server.close();
});

test('a participant cannot view or edit another participant\'s character; an admin can view but not edit it', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const owner = await makeUserAndSession();
  const stranger = await makeUserAndSession();
  const admin = await makeUserAndSession('admin');
  const eventId = await makeEvent([]);

  const createRes = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
    body: JSON.stringify({ eventId, name: 'Owned', data: {} }),
  });
  const { id } = await createRes.json();

  const strangerGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: stranger.cookie } });
  assert.equal(strangerGet.status, 403);

  const adminGet = await fetch(`http://localhost:${port}/characters/${id}`, { headers: { Cookie: admin.cookie } });
  assert.equal(adminGet.status, 200);

  const strangerPut = await fetch(`http://localhost:${port}/characters/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
    body: JSON.stringify({ name: 'Hijacked' }),
  });
  assert.equal(strangerPut.status, 403);

  const adminPut = await fetch(`http://localhost:${port}/characters/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Hijacked' }),
  });
  assert.equal(adminPut.status, 403);

  const ownerPut = await fetch(`http://localhost:${port}/characters/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
    body: JSON.stringify({ name: 'Renamed' }),
  });
  assert.equal(ownerPut.status, 200);
  assert.equal((await ownerPut.json()).name, 'Renamed');

  server.close();
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/integration/characters.test.js
```

Expected: FAIL — `Cannot find module '../../backend/characters/repository.js'`.

- [ ] **Step 3: Write `backend/characters/repository.js`**

```js
import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getEvent } from '../events/repository.js';

export async function createCharacter(userId, { eventId, name, data }) {
  const event = await getEvent(eventId);
  if (!event) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }

  const errors = validateCharacterData(event.character_form_schema, data ?? {});
  if (errors.length > 0) {
    const err = new Error('invalid character data');
    err.code = 'INVALID_CHARACTER_DATA';
    err.details = errors;
    throw err;
  }

  const { rows } = await query(
    `INSERT INTO characters (user_id, event_id, name, data)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, event_id, name, data, created_at`,
    [userId, eventId, name, JSON.stringify(data ?? {})]
  );
  return rows[0];
}

export async function getCharacter(id) {
  const { rows } = await query(
    'SELECT id, user_id, event_id, name, data, created_at FROM characters WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

export async function listCharactersForUser(userId) {
  const { rows } = await query(
    'SELECT id, user_id, event_id, name, data, created_at FROM characters WHERE user_id = $1 ORDER BY created_at',
    [userId]
  );
  return rows;
}

export async function updateCharacter(id, { name, data }) {
  const character = await getCharacter(id);
  if (!character) return null;

  if (data !== undefined) {
    const event = await getEvent(character.event_id);
    const errors = validateCharacterData(event.character_form_schema, data);
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
  }

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($2, name),
       data = COALESCE($3, data)
     WHERE id = $1
     RETURNING id, user_id, event_id, name, data, created_at`,
    [id, name ?? null, data !== undefined ? JSON.stringify(data) : null]
  );
  return rows[0];
}
```

- [ ] **Step 4: Write `backend/characters/routes.js`**

```js
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { createCharacter, getCharacter, listCharactersForUser, updateCharacter } from './repository.js';

router.post('/characters', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { eventId, name, data } = body;
  if (!eventId || !name) {
    return { status: 400, body: { error: 'eventId and name are required' } };
  }
  try {
    const character = await createCharacter(user.id, { eventId, name, data });
    return { status: 201, body: character };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));

router.get('/characters', requireAuth(async ({ user }) => {
  const characters = await listCharactersForUser(user.id);
  return { status: 200, body: characters };
}));

router.get('/characters/:id', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  if (character.user_id !== user.id && user.role !== 'admin') {
    return { status: 403, body: { error: 'forbidden' } };
  }
  return { status: 200, body: character };
}));

router.put('/characters/:id', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  if (character.user_id !== user.id) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const updated = await updateCharacter(params.id, body);
    return { status: 200, body: updated };
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));
```

- [ ] **Step 5: Wire it into the server entry point**

Read `backend/server.js` and add:

```js
import './characters/routes.js';
```

- [ ] **Step 6: Run test to verify it passes**

```bash
node --test tests/integration/characters.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```

Expected: all tests across this plan and Plans 1-3 pass.

- [ ] **Step 8: Verify the dev stack end-to-end**

```bash
docker compose up -d --build
```

Register+verify+login an admin (directly flip their role to `admin` in the DB for this manual check, or use an existing admin), create an event with a schema, create a character against it as a participant, confirm validation errors surface correctly. Then:

```bash
docker compose down
```

- [ ] **Step 9: Commit**

```bash
git add backend/characters/repository.js backend/characters/routes.js backend/server.js tests/integration/characters.test.js
git commit -m "feat: characters crud with schema validation and ownership checks"
```

---

## Self-Review Notes

- **Spec coverage**: `events`/`characters` JSONB schema exactly as specced ✓; server-side validation of required/unknown fields against `character_form_schema` ✓ (Task 2, matches spec's Testing section requirements verbatim); `participant` can create/edit own characters ✓; `admin` can view (not edit) any character, manages events/schema ✓; role checked server-side via `requireAuth`/`requireRole` on every route ✓.
- **Placeholder scan**: no TBD/TODO; every step has runnable code.
- **Type/name consistency**: `validateCharacterData(schema, data)` (Task 2) is called identically in `characters/repository.js`'s `createCharacter` and `updateCharacter` (Task 4). `getEvent(id)` (Task 3) returns the same row shape (`character_form_schema` already JSON-parsed by `pg`'s jsonb handling) that Task 4 passes straight into `validateCharacterData`. Error codes (`EVENT_NOT_FOUND`, `INVALID_CHARACTER_DATA`) are thrown and caught with the same string literals in both the repository and route layers.
