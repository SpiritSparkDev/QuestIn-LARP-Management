# Verwaltete Personen (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any logged-in, non-guest account create, edit, delete, and
act on behalf of its own "verwaltete Personen" (dependents without their
own login) — full backend: data model, CRUD, character/registration
delegation, payment, and self-service conversion into a real account.
Frontend (account.html section + new managed-person.html page) is a
separate follow-up plan, same split this project used for Gruppen &
Berechtigungen (Groups Foundation backend, then Group Management UI).

**Architecture:** Extends the existing `is_guest` user mechanism
(`db/migrations/046_guest_accounts.sql`) with a new nullable
`users.managed_by_user_id` ownership column, instead of a parallel data
model. A managed person is an ordinary `users` row
(`is_guest=true`, `password_hash=NULL`) owned by another user. New module
`backend/managedPersons/` provides CRUD plus thin wrapper routes that
delegate to the EXISTING `characters`/`registrations`/`payments`
repository functions with the managed person's id as the acting
`userId`. Three existing files get a small ownership-check extension
(`characters/routes.js`, `characterFiles/routes.js`, `payments/routes.js`)
so a single character/registration/payment, once created, is reachable
through its normal id-based route for both the managed person's owner
and (unchanged) its own self-service case.

**Tech Stack:** Node.js (no framework — this project's own
`backend/routes.js` router), PostgreSQL via `backend/db.js`, `node:test` +
`node:assert/strict` integration tests against a real test database
(`tests/integration/*.test.js`, pattern: `createServer().listen(0)` +
`fetch`, see `tests/integration/members.test.js`).

**Spec:** `docs/superpowers/specs/2026-10-02-verwaltete-personen-design.md`
(sections 1-5, 7-9 — section 6 is the frontend follow-up plan's concern)

## Global Constraints

- Every managed person is a `users` row with `is_guest=true`,
  `password_hash=NULL`, same `group_id` as its owner at creation time.
- `users.managed_by_user_id` (nullable FK, `ON DELETE SET NULL`)
  distinguishes a managed person from an anonymous ticket-widget guest
  (`NULL`).
- `users.email` becomes nullable (spec section 4) — a managed person's
  email is optional.
- Ownership check everywhere: `managed_by_user_id = <acting account's id>`.
  Not found or not owned → **404**, never 403 (spec section 5.1 — don't
  leak existence of another account's managed person).
- `DELETE /managed-persons/:id` is blocked (409) if the managed person has
  any `registrations` row — event/check-in history is never silently
  destroyed.
- No new dependency. No new test framework. Every new integration test
  file follows the exact `createServer().listen(0)` + try/finally pattern
  already used throughout `tests/integration/` (see `members.test.js`) —
  do NOT introduce `tests/testServer.js`'s `withTestServer` wrapper here,
  this project's newer files still use the manual pattern consistently.
- Last task's last step is a full `npm test` run (project convention —
  see `docs/superpowers/specs/2026-10-02-verwaltete-personen-design.md`
  section 9 and this project's own plan history: a scoped-subset-only
  final task has caused real regressions to slip through before).

---

### Task 1: Data model + managed-persons CRUD

**Files:**
- Create: `db/migrations/058_managed_by_user_id.sql`
- Create: `backend/managedPersons/repository.js`
- Create: `backend/managedPersons/routes.js`
- Modify: `backend/server.js` (register the new route module)
- Modify: `backend/members/routes.js:15-19` (export `filterToAllowedFields`)
- Test: `tests/integration/managedPersons.test.js`
- Test: `tests/integration/schema-users.test.js` (append 2 assertions)

**Interfaces:**
- Consumes: `query`, `withTransaction` from `backend/db.js`; `getAccountFieldSchema` from `backend/accountFieldSchema/repository.js`; `encryptFieldBlob`/`decryptFieldBlob` from `backend/accountFields.js`; `displayName` from `backend/displayName.js`; `isValidEmail` from `backend/validation.js`; `requireAuth` from `backend/middleware/authenticate.js`; `readJsonBody` from `backend/httpBody.js`.
- Produces (used by later tasks in this plan):
  - `isManagedBy(targetUserId, ownerId): Promise<boolean>` — exported from `backend/managedPersons/repository.js`. Task 2 and Task 3 import this.
  - `getManagedPerson(id, ownerId): Promise<ManagedPerson|null>` — exported from `backend/managedPersons/repository.js`. `ManagedPerson` shape: `{ id, email, firstName, lastName, nickname, name, canDelete, address, birthdate, phone, emergencyContactFirstName, emergencyContactLastName, emergencyContactPhone, medicalNotes, ...other schema fields }` (same shape as `getAccount`'s return in `backend/accounts/repository.js`, plus `canDelete`).
  - `filterToAllowedFields(body, allowedFields): Promise<string[]>` — now exported from `backend/members/routes.js`. Task 4 also uses it.

- [ ] **Step 1: Write the migration**

Create `db/migrations/058_managed_by_user_id.sql`:

```sql
ALTER TABLE users ADD COLUMN managed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX users_managed_by_user_id_idx ON users (managed_by_user_id) WHERE managed_by_user_id IS NOT NULL;

-- 'E-Mail optional': a managed person commonly has none (e.g. a small
-- child). NULL stays unique-safe (Postgres treats NULL <> NULL), and every
-- existing consumer only reads users.email for login/mail, neither of
-- which applies to an email-less managed person.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
```

- [ ] **Step 2: Run the migration against the test DB and verify**

Run: `node db/migrate.js` (with `DATABASE_URL` pointing at the local dev/test Postgres — see `CLAUDE.md`'s `docker-compose.dev.yml` instructions; the test suite itself also runs migrations on startup, see Step 8)

Expected: logs `applied migration { file: '058_managed_by_user_id.sql' }`, no error.

- [ ] **Step 3: Write the repository module**

Create `backend/managedPersons/repository.js`:

```javascript
import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

const SELECT_COLUMNS = `
  id, email, first_name, last_name, nickname, account_data_enc,
  NOT EXISTS (SELECT 1 FROM registrations WHERE registrations.user_id = users.id) AS can_delete
`;

function decryptManagedPerson(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    canDelete: row.can_delete,
    ...decryptFieldBlob(row.account_data_enc),
  };
}

// True only for an existing managed person owned by ownerId -- NOT true
// for ownerId itself (callers that also need to allow "acting on your own
// id" check that separately, matching the existing isOwner pattern in
// characters/routes.js and payments/routes.js).
export async function isManagedBy(targetUserId, ownerId) {
  const { rows } = await query(
    'SELECT 1 FROM users WHERE id = $1 AND managed_by_user_id = $2',
    [targetUserId, ownerId]
  );
  return rows.length > 0;
}

export async function listManagedPersons(ownerId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE managed_by_user_id = $1 ORDER BY first_name, last_name`,
    [ownerId]
  );
  return rows.map(decryptManagedPerson);
}

export async function getManagedPerson(id, ownerId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1 AND managed_by_user_id = $2`,
    [id, ownerId]
  );
  return rows[0] ? decryptManagedPerson(rows[0]) : null;
}

export async function createManagedPerson({ ownerId, groupId, email, firstName, lastName, nickname, ...otFields }) {
  const schema = await getAccountFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields[field.key] !== undefined) data[field.key] = otFields[field.key];
  }
  try {
    const { rows } = await query(
      `INSERT INTO users (email, first_name, last_name, nickname, group_id, is_guest, email_verified, account_data_enc, managed_by_user_id)
       VALUES ($1, $2, $3, $4, $5, true, false, $6, $7)
       RETURNING id`,
      [email || null, firstName, lastName, nickname || null, groupId, encryptFieldBlob(data), ownerId]
    );
    return getManagedPerson(rows[0].id, ownerId);
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('Diese E-Mail-Adresse wird bereits verwendet.');
      dup.code = 'EMAIL_TAKEN';
      throw dup;
    }
    throw err;
  }
}

export async function updateManagedPerson(id, ownerId, fields) {
  const schema = await getAccountFieldSchema();
  const { rows: currentRows } = await query(
    'SELECT account_data_enc FROM users WHERE id = $1 AND managed_by_user_id = $2',
    [id, ownerId]
  );
  if (currentRows.length === 0) return null;
  const nextData = decryptFieldBlob(currentRows[0].account_data_enc);
  for (const field of schema) {
    if (fields[field.key] !== undefined) nextData[field.key] = fields[field.key];
  }

  try {
    const { rows } = await query(
      `UPDATE users SET
         first_name = COALESCE($3, first_name),
         last_name = COALESCE($4, last_name),
         nickname = COALESCE($5, nickname),
         email = COALESCE($6, email),
         account_data_enc = $7
       WHERE id = $1 AND managed_by_user_id = $2
       RETURNING id`,
      [
        id, ownerId,
        fields.firstName ?? null,
        fields.lastName ?? null,
        fields.nickname ?? null,
        fields.email || null,
        encryptFieldBlob(nextData),
      ]
    );
    if (rows.length === 0) return null;
    return getManagedPerson(id, ownerId);
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('Diese E-Mail-Adresse wird bereits verwendet.');
      dup.code = 'EMAIL_TAKEN';
      throw dup;
    }
    throw err;
  }
}

export async function deleteManagedPerson(id, ownerId) {
  const { rows: regRows } = await query(
    `SELECT 1 FROM registrations r JOIN users u ON u.id = r.user_id
     WHERE r.user_id = $1 AND u.managed_by_user_id = $2`,
    [id, ownerId]
  );
  if (regRows.length > 0) {
    const err = new Error('Diese Person hat bereits Event-Anmeldungen und kann nicht gelöscht werden.');
    err.code = 'HAS_REGISTRATIONS';
    throw err;
  }
  const { rows } = await query(
    'DELETE FROM users WHERE id = $1 AND managed_by_user_id = $2 RETURNING id',
    [id, ownerId]
  );
  return rows.length > 0;
}
```

Note on the `deleteManagedPerson` registrations check: it joins back
through `users.managed_by_user_id = ownerId` in the same query rather than
checking ownership separately first, so a non-owner's delete attempt and a
"has registrations" delete attempt both correctly fail closed without a
race between a separate ownership-SELECT and the DELETE.

- [ ] **Step 4: Export `filterToAllowedFields` from members/routes.js**

In `backend/members/routes.js:15`, change:

```javascript
async function filterToAllowedFields(body, allowedFields) {
```

to:

```javascript
export async function filterToAllowedFields(body, allowedFields) {
```

- [ ] **Step 5: Write the routes module**

Create `backend/managedPersons/routes.js`:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { isValidEmail } from '../validation.js';
import { filterToAllowedFields } from '../members/routes.js';
import {
  listManagedPersons, getManagedPerson, createManagedPerson, updateManagedPerson, deleteManagedPerson,
} from './repository.js';

router.get('/managed-persons', requireAuth(async ({ user }) => {
  const persons = await listManagedPersons(user.id);
  return { status: 200, body: persons };
}));

router.get('/managed-persons/:id', requireAuth(async ({ params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  return { status: 200, body: person };
}));

router.post('/managed-persons', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { email, firstName, lastName, nickname, ...otFields } = body;
  if (!firstName || !lastName) {
    return { status: 400, body: { error: 'firstName and lastName are required' } };
  }
  if (email && !isValidEmail(email)) {
    return { status: 400, body: { error: 'invalid email format' } };
  }

  const disallowed = await filterToAllowedFields(otFields, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to set: ${disallowed.join(', ')}` } };
  }

  try {
    const person = await createManagedPerson({
      ownerId: user.id, groupId: user.group.id, email: email?.toLowerCase(), firstName, lastName, nickname, ...otFields,
    });
    return { status: 201, body: person };
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.patch('/managed-persons/:id', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.email && !isValidEmail(body.email)) {
    return { status: 400, body: { error: 'invalid email format' } };
  }

  const disallowed = await filterToAllowedFields(body, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to set: ${disallowed.join(', ')}` } };
  }

  try {
    const fields = body.email !== undefined ? { ...body, email: body.email?.toLowerCase() } : body;
    const person = await updateManagedPerson(params.id, user.id, fields);
    if (!person) return { status: 404, body: { error: 'managed person not found' } };
    return { status: 200, body: person };
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/managed-persons/:id', requireAuth(async ({ params, user }) => {
  try {
    const deleted = await deleteManagedPerson(params.id, user.id);
    if (!deleted) return { status: 404, body: { error: 'managed person not found' } };
    return { status: 200, body: { deleted: true } };
  } catch (err) {
    if (err.code === 'HAS_REGISTRATIONS') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));
```

`filterToAllowedFields`'s `accountFieldKeys` list (in `members/routes.js`)
includes `'group'`, but `group`/`groupId` is never read from the request
body here at all (always server-computed from `user.group.id`) — so there
is no privilege-escalation path to close for this field, unlike
`/members/invite`.

- [ ] **Step 6: Register the route module**

In `backend/server.js`, add after the `./members/routes.js` import (line 20):

```javascript
import './managedPersons/routes.js';
```

- [ ] **Step 7: Write the integration tests**

Create `tests/integration/managedPersons.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createServer } = await import('../../backend/server.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Owner', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`managed-owner-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('POST /managed-persons creates a person owned by the caller, in the caller\'s own group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { userId: ownerId, cookie } = await makeUserAndSession('mitglied');

    const res = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'Kind' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.firstName, 'ManagedTestPerson');
    assert.equal(body.canDelete, true);

    const { rows } = await query(
      'SELECT is_guest, password_hash, managed_by_user_id, group_id FROM users WHERE id = $1',
      [body.id]
    );
    assert.equal(rows[0].is_guest, true);
    assert.equal(rows[0].password_hash, null);
    assert.equal(rows[0].managed_by_user_id, ownerId);
    const { rows: ownerRows } = await query('SELECT group_id FROM users WHERE id = $1', [ownerId]);
    assert.equal(rows[0].group_id, ownerRows[0].group_id);
  } finally {
    server.close();
  }
});

test('POST /managed-persons without email succeeds (email is optional)', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');

    const res = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'OhneMail' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.email, null);
  } finally {
    server.close();
  }
});

test('GET /managed-persons lists only the caller\'s own', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: cookieA } = await makeUserAndSession('mitglied');
    const { cookie: cookieB } = await makeUserAndSession('mitglied');

    await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'VonA' }),
    });

    const resB = await fetch(`http://localhost:${port}/managed-persons`, { headers: { Cookie: cookieB } });
    assert.equal(resB.status, 200);
    assert.deepEqual(await resB.json(), []);

    const resA = await fetch(`http://localhost:${port}/managed-persons`, { headers: { Cookie: cookieA } });
    const bodyA = await resA.json();
    assert.equal(bodyA.length, 1);
    assert.equal(bodyA[0].lastName, 'VonA');
  } finally {
    server.close();
  }
});

test('a foreign account cannot read, edit, or delete another account\'s managed person (404, not 403)', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');

    const createRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'Geheim' }),
    });
    const { id } = await createRes.json();

    const getRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { headers: { Cookie: strangerCookie } });
    assert.equal(getRes.status, 404);

    const patchRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ lastName: 'Uebernommen' }),
    });
    assert.equal(patchRes.status, 404);

    const deleteRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { method: 'DELETE', headers: { Cookie: strangerCookie } });
    assert.equal(deleteRes.status, 404);
  } finally {
    server.close();
  }
});

test('PATCH /managed-persons/:id rejects an OT field the caller isn\'t permitted to set themselves', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const createRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'Feld' }),
    });
    const { id } = await createRes.json();

    // 'mitglied' lacks 'medicalNotes' in its default accountFields (same
    // fixture assumption /members/invite's existing tests already rely on).
    const res = await fetch(`http://localhost:${port}/managed-persons/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ medicalNotes: 'sollte nicht ankommen' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('DELETE /managed-persons/:id succeeds with no registrations, 409s once one exists', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const createRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'LoeschTest' }),
    });
    const { id } = await createRes.json();

    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date) VALUES ('Managed Delete Test Event', '2026-01-01') RETURNING id"
    );
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role) VALUES ($1, $2, 'helfer')",
      [id, eventRows[0].id]
    );

    const blockedRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(blockedRes.status, 409);

    await query('DELETE FROM registrations WHERE user_id = $1', [id]);

    const okRes = await fetch(`http://localhost:${port}/managed-persons/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(okRes.status, 200);
    const { rows } = await query('SELECT 1 FROM users WHERE id = $1', [id]);
    assert.equal(rows.length, 0);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM registrations WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Managed Delete Test%')");
  await query("DELETE FROM events WHERE name LIKE 'Managed Delete Test%'");
  await query("DELETE FROM users WHERE email LIKE 'managed-owner-%' OR first_name = 'ManagedTestPerson'");
  await closePool();
});
```

- [ ] **Step 8: Run the new test file**

Run: `node --test tests/integration/managedPersons.test.js`
Expected: all tests PASS. If the DB connection fails, start the dev
Postgres first: `docker compose -f docker-compose.dev.yml up -d db` (see
`CLAUDE.md`).

- [ ] **Step 9: Add 2 migration assertions to the existing schema test**

In `tests/integration/schema-users.test.js`, add after the
`'users.account_data_enc column exists after migration'` test (currently
ending at line 107, right before `test.after`):

```javascript
test('users.managed_by_user_id column exists, nullable, FK to users', async () => {
  const { rows } = await query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'managed_by_user_id'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_nullable, 'YES');
});

test('users.email is nullable after migration', async () => {
  const { rows } = await query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'email'`
  );
  assert.equal(rows[0].is_nullable, 'YES');
});
```

- [ ] **Step 10: Run both test files together to catch cross-file DB-state interference**

Run: `node --test tests/integration/managedPersons.test.js tests/integration/schema-users.test.js`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add db/migrations/058_managed_by_user_id.sql backend/managedPersons backend/server.js backend/members/routes.js tests/integration/managedPersons.test.js tests/integration/schema-users.test.js
git commit -m "feat: add verwaltete Personen CRUD (managed-by-user_id, managed-persons API)"
```

---

### Task 2: Characters for a managed person

**Files:**
- Create: `backend/managedPersons/characterRoutes.js`
- Modify: `backend/server.js` (register it)
- Modify: `backend/characters/routes.js:54-114` (extend 3 ownership checks)
- Modify: `backend/characterFiles/routes.js:30-32` (extend `canManage`)
- Test: `tests/integration/managedPersons.test.js` (append)
- Test: `tests/integration/characters.test.js` (append ownership-extension cases)

**Interfaces:**
- Consumes: `isManagedBy` from `backend/managedPersons/repository.js` (Task 1); `getManagedPerson` from the same (Task 1); `createCharacter`, `listCharactersForUser`, `getCharacter` from `backend/characters/repository.js` (pre-existing, unchanged signatures: `createCharacter(userId, {characterClass, name, data})`, `listCharactersForUser(userId)`, `getCharacter(id)`).
- Produces: nothing new consumed by later tasks (Task 3/4 only need `isManagedBy`, already available from Task 1).

- [ ] **Step 1: Write the failing ownership-extension tests first (characters.test.js)**

Append to `tests/integration/characters.test.js` (check its existing
top-of-file helpers first — it already has a `makeUserAndSession`-style
helper and `query`/`createServer` imports matching the pattern in Task 1's
Step 7; reuse those, don't redeclare):

```javascript
test('an owner can read/update/delete a character belonging to their managed person', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const createPersonRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'CharOwner' }),
    });
    const { id: managedId } = await createPersonRes.json();

    const { rows: charRows } = await query(
      "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Managed Char', '{}') RETURNING id",
      [managedId]
    );
    const characterId = charRows[0].id;

    const getRes = await fetch(`http://localhost:${port}/characters/${characterId}`, { headers: { Cookie: ownerCookie } });
    assert.equal(getRes.status, 200);

    const putRes = await fetch(`http://localhost:${port}/characters/${characterId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ name: 'Managed Char Renamed', data: {} }),
    });
    assert.equal(putRes.status, 200);

    const deleteRes = await fetch(`http://localhost:${port}/characters/${characterId}`, { method: 'DELETE', headers: { Cookie: ownerCookie } });
    assert.equal(deleteRes.status, 200);
  } finally {
    server.close();
  }
});

test('a stranger cannot read/update/delete another account\'s managed person\'s character', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');
    const createPersonRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'CharStranger' }),
    });
    const { id: managedId } = await createPersonRes.json();
    const { rows: charRows } = await query(
      "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Managed Char 2', '{}') RETURNING id",
      [managedId]
    );
    const characterId = charRows[0].id;

    const putRes = await fetch(`http://localhost:${port}/characters/${characterId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ name: 'Hijacked', data: {} }),
    });
    assert.equal(putRes.status, 403);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify these 2 new tests fail**

Run: `node --test tests/integration/characters.test.js`
Expected: the two new tests FAIL (owner gets 403/404 instead of 200,
since `characters/routes.js` doesn't know about managed persons yet).

- [ ] **Step 3: Extend ownership in characters/routes.js**

In `backend/characters/routes.js`, add the import (after line 6):

```javascript
import { isManagedBy } from '../managedPersons/repository.js';
```

Then change each of the 3 ownership checks. Line 58-59 (inside `GET /characters/:id`):

```javascript
  const isOwner = character.user_id === user.id;
  const isElevated = user.group.canOverrideCheckinStatus;
```
becomes:
```javascript
  const isOwner = character.user_id === user.id || await isManagedBy(character.user_id, user.id);
  const isElevated = user.group.canOverrideCheckinStatus;
```

Line 75-76 (inside `PUT /characters/:id`) and line 102-103 (inside
`DELETE /characters/:id`): identical one-line change, same replacement.

- [ ] **Step 4: Run to verify the characters.test.js tests now pass**

Run: `node --test tests/integration/characters.test.js`
Expected: all PASS, including the 2 new ones.

- [ ] **Step 5: Write the failing character-file-ownership test**

Append to `tests/integration/managedPersons.test.js`:

```javascript
test('an owner can upload/list/delete a file on their managed person\'s character', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'FileOwner' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: charRows } = await query(
      "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Managed File Char', '{}') RETURNING id",
      [managedId]
    );
    const characterId = charRows[0].id;
    const tinyPng = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

    const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ kind: 'image', filename: 'a.png', mimeType: 'image/png', dataBase64: tinyPng, gdprConsent: true }),
    });
    assert.equal(uploadRes.status, 201);
    const file = await uploadRes.json();

    const listRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, { headers: { Cookie: cookie } });
    assert.equal((await listRes.json()).length, 1);

    const deleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${file.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(deleteRes.status, 200);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `node --test tests/integration/managedPersons.test.js`
Expected: FAIL (upload 403s today).

- [ ] **Step 7: Extend characterFiles/routes.js's `canManage`**

In `backend/characterFiles/routes.js`, add the import (after line 7):

```javascript
import { isManagedBy } from '../managedPersons/repository.js';
```

Replace lines 30-32:

```javascript
function canManage(character, user) {
  return character.user_id === user.id || user.group.canOverrideCheckinStatus;
}
```

with:

```javascript
async function canManage(character, user) {
  if (character.user_id === user.id || user.group.canOverrideCheckinStatus) return true;
  return isManagedBy(character.user_id, user.id);
}
```

`canManage` is now async — every call site must `await` it. It's called
in 4 places in this file:
- Line 41 (`POST /characters/:id/files`): `if (!canManage(character, user))` → `if (!(await canManage(character, user)))`.
- Line 107 (`GET /characters/:characterId/files`): `canManage(character, user) ? files : ...` → `(await canManage(character, user)) ? files : ...`.
- Line 115 (`GET .../files/:fileId`, via `canView`): see next change below.
- Line 149 (`DELETE .../files/:fileId`): `!canManage(character, user)` → `!(await canManage(character, user))`.

`canView` (line 34-36) wraps `canManage` and must also become async:

```javascript
async function canView(file, character, user) {
  return file.is_public || canManage(character, user);
}
```

And its one call site, line 115: `!canView(file, character, user)` →
`!(await canView(file, character, user))`.

- [ ] **Step 8: Run to verify the new test passes**

Run: `node --test tests/integration/managedPersons.test.js`
Expected: all PASS.

- [ ] **Step 9: Write the character-delegation routes**

Create `backend/managedPersons/characterRoutes.js`:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getManagedPerson } from './repository.js';
import { createCharacter, listCharactersForUser } from '../characters/repository.js';

router.get('/managed-persons/:id/characters', requireAuth(async ({ params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  const characters = await listCharactersForUser(person.id);
  return { status: 200, body: characters };
}));

router.post('/managed-persons/:id/characters', requireAuth(async ({ req, params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };

  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { class: characterClass = 'sc', name, data } = body;
  if (characterClass !== 'sc' && characterClass !== 'nsc') {
    return { status: 400, body: { error: 'class must be "sc" or "nsc"' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }

  try {
    const character = await createCharacter(person.id, { characterClass, name, data });
    return { status: 201, body: character };
  } catch (err) {
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));
```

This deliberately mirrors `backend/characters/routes.js:11-36`'s
validation 1:1 (same error shapes) — the managed-person form on the
frontend follow-up plan can therefore reuse the exact same client-side
error handling as the self-service character form.

- [ ] **Step 10: Register the route module**

In `backend/server.js`, add after `import './managedPersons/routes.js';`:

```javascript
import './managedPersons/characterRoutes.js';
```

- [ ] **Step 11: Write the delegation-route tests**

Append to `tests/integration/managedPersons.test.js`:

```javascript
test('POST and GET /managed-persons/:id/characters creates and lists a character for the managed person', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'CharCreate' }),
    });
    const { id: managedId } = await personRes.json();

    const createRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ class: 'sc', name: 'Delegated Char', data: {} }),
    });
    assert.equal(createRes.status, 201);
    const character = await createRes.json();
    assert.equal(character.user_id, managedId);

    const listRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/characters`, { headers: { Cookie: cookie } });
    const list = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, character.id);
  } finally {
    server.close();
  }
});

test('a stranger gets 404 from /managed-persons/:id/characters, not another account\'s data', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'CharStranger2' }),
    });
    const { id: managedId } = await personRes.json();

    const res = await fetch(`http://localhost:${port}/managed-persons/${managedId}/characters`, { headers: { Cookie: strangerCookie } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 12: Run the full managed-persons and characters test files**

Run: `node --test tests/integration/managedPersons.test.js tests/integration/characters.test.js`
Expected: all PASS.

- [ ] **Step 13: Commit**

```bash
git add backend/managedPersons/characterRoutes.js backend/server.js backend/characters/routes.js backend/characterFiles/routes.js tests/integration/managedPersons.test.js tests/integration/characters.test.js
git commit -m "feat: let an owner manage their managed person's characters and files"
```

---

### Task 3: Event registration + payment for a managed person

**Files:**
- Create: `backend/managedPersons/registrationRoutes.js`
- Modify: `backend/server.js` (register it)
- Modify: `backend/payments/routes.js:43-44` (extend ownership check)
- Test: `tests/integration/managedPersons.test.js` (append)
- Test: `tests/integration/payments.test.js` (append 1 case)

**Interfaces:**
- Consumes: `isManagedBy`, `getManagedPerson` from `backend/managedPersons/repository.js` (Task 1); `registerForEvent`, `unregisterFromEvent`, `listRegistrationsForUser` from `backend/registrations/repository.js` — pre-existing, unchanged signature `registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, flags, priceGroup, otFields, requestingUser, waiverAccepted)`.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing registration-delegation tests**

Append to `tests/integration/managedPersons.test.js`:

```javascript
test('POST/DELETE /managed-persons/:id/events/:eventId/register registers and unregisters the managed person', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'RegOwner' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Managed Register Test Event', '2026-02-01', true) RETURNING id"
    );
    const eventId = eventRows[0].id;

    const registerRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(registerRes.status, 201);
    const registration = await registerRes.json();
    assert.equal(registration.user_id, managedId);

    const listRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/registrations`, { headers: { Cookie: cookie } });
    const list = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].eventId, eventId);

    const unregisterRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/events/${eventId}/register`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(unregisterRes.status, 200);
  } finally {
    server.close();
  }
});

test('a stranger gets 404 attempting to register someone else\'s managed person', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'RegStranger' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Managed Register Stranger Event', '2026-02-02', true) RETURNING id"
    );

    const res = await fetch(`http://localhost:${port}/managed-persons/${managedId}/events/${eventRows[0].id}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify these fail**

Run: `node --test tests/integration/managedPersons.test.js`
Expected: FAIL (no such routes yet — 404 from the router itself for the
owner case too, which happens to look similar but is for the wrong
reason; this will be obviously fixed once Step 3 lands).

- [ ] **Step 3: Write the registration-delegation routes**

Create `backend/managedPersons/registrationRoutes.js`. This mirrors
`backend/registrations/routes.js:37-77`'s 3 self-service routes, with the
managed person as the acting `userId` and a `requestingUser` object built
from the managed person (same pattern as the existing ticket-widget guest
flow in `backend/guestRegistrations/routes.js:84`, which already proves
this exact pattern works for a guest who isn't the literal session user):

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getManagedPerson } from './repository.js';
import { registerForEvent, unregisterFromEvent, listRegistrationsForUser } from '../registrations/repository.js';

// groups/repository.js isn't imported here -- the managed person's own
// group permissions (canEditCharacters) are needed for registerForEvent's
// EVENT_NOT_ACTIVE gate, same as the ticket-widget guest flow's synthetic
// requestingUser. Looked up fresh rather than trusting any cached value.
import { query } from '../db.js';

async function buildRequestingUser(personId) {
  const { rows } = await query(
    `SELECT groups.key, groups.can_edit_characters FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [personId]
  );
  return { id: personId, group: { key: rows[0].key, canEditCharacters: rows[0].can_edit_characters } };
}

router.post('/managed-persons/:id/events/:eventId/register', requireAuth(async ({ req, params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };

  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const requestingUser = await buildRequestingUser(person.id);
  try {
    const registration = await registerForEvent(
      person.id, params.eventId, body.conRole, body.characterId, body.nscAvailable, body.nscCharacterId,
      body.flags, body.priceGroup, body.otFields, requestingUser, body.waiverAccepted
    );
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'WAIVER_NOT_ACCEPTED') return { status: 400, body: { error: err.message } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    if (err.code === 'EVENT_NOT_ACTIVE') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_REQUIRED' || err.code === 'CHARACTER_NOT_ALLOWED' || err.code === 'CHARACTER_CLASS_MISMATCH') {
      return { status: 400, body: { error: err.message } };
    }
    if (err.code === 'INVALID_NSC_AVAILABILITY') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_FLAG') return { status: 400, body: { error: err.message } };
    if (err.code === 'INVALID_PRICE_GROUP') return { status: 400, body: { error: err.message } };
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    if (err.code === 'CHARACTER_ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.delete('/managed-persons/:id/events/:eventId/register', requireAuth(async ({ params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  try {
    await unregisterFromEvent(person.id, params.eventId);
    return { status: 200, body: { unregistered: true } };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'CANNOT_UNREGISTER') return { status: 409, body: { error: err.message } };
    throw err;
  }
}));

router.get('/managed-persons/:id/registrations', requireAuth(async ({ params, user }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  const registrations = await listRegistrationsForUser(person.id);
  return { status: 200, body: registrations };
}));
```

- [ ] **Step 4: Register the route module**

In `backend/server.js`, add after `import './managedPersons/characterRoutes.js';`:

```javascript
import './managedPersons/registrationRoutes.js';
```

- [ ] **Step 5: Run to verify the Step 1 tests now pass**

Run: `node --test tests/integration/managedPersons.test.js`
Expected: all PASS.

- [ ] **Step 6: Write the failing checkout-session-ownership test**

Check `tests/integration/payments.test.js`'s existing top-of-file imports
first (it will already mock/stub `getStripeClient`, following that file's
own existing pattern for every new test below rather than reintroducing a
real Stripe call). Append:

```javascript
test('an owner can start a checkout session for their managed person\'s registration', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'PayOwner' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date) VALUES ('Managed Payment Test Event', '2026-03-01') RETURNING id"
    );
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role, amount_due_cents) VALUES ($1, $2, 'helfer', 1000)",
      [managedId, eventRows[0].id]
    );

    const res = await fetch(`http://localhost:${port}/events/${eventRows[0].id}/registrations/${managedId}/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    // 502 is the existing, expected response when Stripe isn't configured
    // in this test environment (see the same assertion style for the
    // self-service checkout-session tests already in this file) -- the
    // point of this test is that ownership passes (not a 403), not that
    // a real Stripe session gets created.
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 404);
  } finally {
    server.close();
  }
});

test('a stranger cannot start a checkout session for someone else\'s managed person', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: ownerCookie } = await makeUserAndSession('mitglied');
    const { cookie: strangerCookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'PayStranger' }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date) VALUES ('Managed Payment Stranger Event', '2026-03-02') RETURNING id"
    );
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role, amount_due_cents) VALUES ($1, $2, 'helfer', 1000)",
      [managedId, eventRows[0].id]
    );

    const res = await fetch(`http://localhost:${port}/events/${eventRows[0].id}/registrations/${managedId}/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
```

Check first whether `tests/integration/payments.test.js` already defines
its own `makeUserAndSession` helper under a different name (e.g.
`makeAccountAndSession`) — reuse whatever it already has rather than
redeclaring; only the managed-person creation call above is genuinely new.

- [ ] **Step 7: Run to verify the "stranger" test fails, "owner" test passes by coincidence**

Run: `node --test tests/integration/payments.test.js`
Expected: the stranger test currently returns 404 (route itself 404s
before any ownership check — `params.userId !== user.id` is checked
first and returns 403 today, so actually expect the owner test to FAIL
with 403, and the stranger test to PASS already since it's also not
`user.id`). Confirm by reading the actual output rather than assuming —
either way, Step 8 fixes the owner case correctly either way.

- [ ] **Step 8: Extend the checkout-session ownership check**

In `backend/payments/routes.js`, add the import (near the top, after the
existing `getPaymentSettingsForUse` import):

```javascript
import { isManagedBy } from '../managedPersons/repository.js';
```

Change line 44:

```javascript
  if (params.userId !== user.id) return { status: 403, body: { error: 'forbidden' } };
```

to:

```javascript
  if (params.userId !== user.id && !(await isManagedBy(params.userId, user.id))) {
    return { status: 403, body: { error: 'forbidden' } };
  }
```

- [ ] **Step 9: Run to verify both tests now pass**

Run: `node --test tests/integration/payments.test.js`
Expected: all PASS.

- [ ] **Step 10: Run the full managed-persons, registrations, and payments test files together**

Run: `node --test tests/integration/managedPersons.test.js tests/integration/registrations.test.js tests/integration/payments.test.js`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add backend/managedPersons/registrationRoutes.js backend/server.js backend/payments/routes.js tests/integration/managedPersons.test.js tests/integration/payments.test.js
git commit -m "feat: let an owner register, unregister, and pay for their managed person"
```

---

### Task 4: Conversion into a real account + full suite

**Files:**
- Create: `backend/managedPersons/convertRoutes.js`
- Modify: `backend/server.js` (register it)
- Modify: `backend/auth/invite.js:40-44` (clear `managed_by_user_id` on guest-conversion redeem)
- Test: `tests/integration/managedPersons.test.js` (append)

**Interfaces:**
- Consumes: `getManagedPerson` from `backend/managedPersons/repository.js` (Task 1); `createInvitation` from `backend/invitations/repository.js` (pre-existing, unchanged — `createInvitation({ email, firstName, lastName, nickname, groupId, invitedBy, eventId, ttlDays, userId, ...otFields })`); `sendInvitationEmail` from `backend/auth/mailer.js` (pre-existing — `sendInvitationEmail(to, token, { account })`); `getAppSettings` from `backend/appSettings/repository.js` (pre-existing, used for `invitationTtlDays`).
- Produces: nothing — this is the last backend task.

- [ ] **Step 1: Write the failing conversion test**

Append to `tests/integration/managedPersons.test.js`:

```javascript
test('POST /managed-persons/:id/convert sends an invitation, and redeeming it fully severs ownership', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'Convert', email: `managed-convert-${crypto.randomUUID()}@example.com` }),
    });
    const { id: managedId } = await personRes.json();
    const { rows: charRows } = await query(
      "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Pre-Convert Char', '{}') RETURNING id",
      [managedId]
    );

    const convertRes = await fetch(`http://localhost:${port}/managed-persons/${managedId}/convert`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(convertRes.status, 201);
    const { link } = await convertRes.json();
    const token = new URL(link).searchParams.get('token');

    const { rows: invRows } = await query('SELECT user_id, invited_by FROM invitations WHERE token = $1', [token]);
    assert.equal(invRows[0].user_id, managedId);

    const redeemRes = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'correct horse battery staple' }),
    });
    assert.equal(redeemRes.status, 200);

    const { rows } = await query('SELECT is_guest, managed_by_user_id FROM users WHERE id = $1', [managedId]);
    assert.equal(rows[0].is_guest, false);
    assert.equal(rows[0].managed_by_user_id, null);

    // The character created before conversion survives, and the former
    // owner has no special access to it any more now that ownership is gone.
    const ownerAccessRes = await fetch(`http://localhost:${port}/characters/${charRows[0].id}`, { headers: { Cookie: cookie } });
    assert.equal(ownerAccessRes.status, 200); // character's own public-field view, not the owner-view
    const body = await ownerAccessRes.json();
    assert.equal(body.id, charRows[0].id);
    // The former owner's /managed-persons list no longer includes this person.
    const listRes = await fetch(`http://localhost:${port}/managed-persons`, { headers: { Cookie: cookie } });
    assert.ok(!(await listRes.json()).some((p) => p.id === managedId));
  } finally {
    server.close();
  }
});

test('POST /managed-persons/:id/convert without an email on file returns 400', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'NoEmailConvert' }),
    });
    const { id: managedId } = await personRes.json();

    const res = await fetch(`http://localhost:${port}/managed-persons/${managedId}/convert`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify these fail**

Run: `node --test tests/integration/managedPersons.test.js`
Expected: FAIL (no `/managed-persons/:id/convert` route yet).

- [ ] **Step 3: Write the conversion route**

Create `backend/managedPersons/convertRoutes.js`:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { query } from '../db.js';
import { getManagedPerson } from './repository.js';
import { createInvitation } from '../invitations/repository.js';
import { sendInvitationEmail, baseUrl } from '../auth/mailer.js';
import { getAppSettings } from '../appSettings/repository.js';
import { logger } from '../logger.js';

router.post('/managed-persons/:id/convert', requireAuth(async ({ params, user, requestId }) => {
  const person = await getManagedPerson(params.id, user.id);
  if (!person) return { status: 404, body: { error: 'managed person not found' } };
  if (!person.email) {
    return { status: 400, body: { error: 'E-Mail-Adresse erforderlich, um einen Account zu erstellen.' } };
  }

  const { rows: groupRows } = await query('SELECT group_id FROM users WHERE id = $1', [person.id]);

  const { invitationTtlDays } = await getAppSettings();
  const invitation = await createInvitation({
    userId: person.id,
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    nickname: person.nickname,
    groupId: groupRows[0].group_id,
    invitedBy: user.id,
    ttlDays: invitationTtlDays,
  });

  try {
    await sendInvitationEmail(invitation.email, invitation.token, { account: invitation });
  } catch (err) {
    logger.error('failed to send managed-person conversion email', { requestId, error: err.message, managedPersonId: person.id });
  }

  const link = `${await baseUrl()}/set-password.html?token=${invitation.token}`;
  return { status: 201, body: { id: invitation.id, link } };
}));
```

- [ ] **Step 4: Register the route module**

In `backend/server.js`, add after `import './managedPersons/registrationRoutes.js';`:

```javascript
import './managedPersons/convertRoutes.js';
```

- [ ] **Step 5: Fix invite.js to sever ownership on guest-conversion redeem**

In `backend/auth/invite.js`, lines 40-44:

```javascript
        const { rowCount } = await client.query(
          `UPDATE users SET password_hash = $2, is_guest = false, email_verified = true, access_token = $3
           WHERE id = $1 AND is_guest = true AND password_hash IS NULL`,
          [invitation.userId, passwordHash, accessToken]
        );
```

becomes:

```javascript
        const { rowCount } = await client.query(
          `UPDATE users SET password_hash = $2, is_guest = false, email_verified = true, access_token = $3, managed_by_user_id = NULL
           WHERE id = $1 AND is_guest = true AND password_hash IS NULL`,
          [invitation.userId, passwordHash, accessToken]
        );
```

This also clears `managed_by_user_id` for the pre-existing ticket-widget
guest-conversion path (no `managed_by_user_id` was ever set there, so
setting it to `NULL` there is a no-op — safe either way).

- [ ] **Step 6: Run to verify the Step 1 tests now pass**

Run: `node --test tests/integration/managedPersons.test.js`
Expected: all PASS.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests PASS (this is the mandatory full-suite gate — see
Global Constraints). If anything outside this plan's own new/modified
files fails, stop and diagnose before proceeding — do not silently ignore
an unrelated-looking failure, per this project's established history of
real cross-task regressions hiding behind "looks unrelated."

- [ ] **Step 8: Commit**

```bash
git add backend/managedPersons/convertRoutes.js backend/server.js backend/auth/invite.js tests/integration/managedPersons.test.js
git commit -m "feat: let an owner convert their managed person into a real account"
```

---

## Self-Review Notes (filled in during plan writing, not execution)

- **Spec coverage:** Section 2 (CRUD, characters, registration, payment,
  conversion, delete) → Tasks 1-4. Section 3 (no shared management after
  conversion) → Task 4 Step 5 + its test. Section 4 (migration, email
  nullable) → Task 1. Section 5.1/5.2/5.3 (all routes + ownership
  extensions + field-permission filtering) → Tasks 1-4. Section 7 (error
  cases) → covered inline per task (404 ownership, 409 delete, 400
  convert-without-email). Section 8 (tests) → one test file per
  concern, full suite in Task 4. Section 9 (migration risk, verify each
  ownership extension against BOTH the pre-existing self-service case and
  the new managed-person case) → each of Tasks 2/3 runs the pre-existing
  test file (`characters.test.js`/`payments.test.js`) alongside the new
  cases, not just the new assertions in isolation. Section 6 (frontend)
  is explicitly out of scope for this plan — follow-up plan.
- **Type/signature consistency check:** `isManagedBy(targetUserId,
  ownerId)` used identically across Tasks 2/3/4. `getManagedPerson(id,
  ownerId)` used identically across Tasks 2/3/4's route files. No
  signature drift found.
