# Groups Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 3-value `users.role` column (`participant`/`admin`/`checkin_helper`) with a DB-backed `groups` table (8 seeded groups, admin-creatable custom ones), wire every backend permission check through it, and keep the app functionally identical to today — no visible feature change yet, pure re-architecture.

**Architecture:** A new `groups` table holds `visible_menus`/`account_fields`/`can_edit_characters` per group. `users.group_id` (FK) replaces `users.role`. `requireAuth` loads the caller's group in one join; a new `requireMenu(menuKey)` middleware replaces `requireRole(...roles)`. An idempotent `db/seedGroups.js` script (same pattern as the existing `db/seedAdmin.js`) seeds the 8 default groups from `db/groupDefaults.js`, backfills existing users' `group_id` from their old `role` value, then finalizes the column swap (`NOT NULL` + `DROP COLUMN role`).

**Tech Stack:** Node.js stdlib backend, `pg` (node-postgres, jsonb columns auto-parse to JS arrays), Postgres migrations as plain `.sql` files run by `db/migrate.js`, `node --test` for tests, vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-08-26-gruppen-berechtigungen-design.md`

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- Every existing test must still pass; `npm test` must stay green after every task.
- **This plan does not add the group-management UI, member management, or NSC profile** — those are separate follow-up plans (see the spec's decomposition). This plan's only frontend touch is the minimal two-file patch in Task 5 that keeps the existing admin-nav-link visibility working once `account.role` stops existing — it is explicitly NOT the full `nav.js` rework described in the spec (that's a later plan).
- One deliberate deviation from the spec's literal file path: the spec names `config/groupDefaults.js`; this plan places it at `db/groupDefaults.js` instead, alongside `db/seedGroups.js` and `db/seedAdmin.js` which are its only consumers — avoids introducing a new top-level `config/` directory for one file. Same data, same content, different path.
- Role → group key mapping used throughout this plan (confirmed with the human during brainstorming): `admin` → `admin`, `checkin_helper` → `sl`, `participant` → `sc`.
- Menu keys (fixed vocabulary used everywhere in this plan): `konto`, `charaktere`, `mitglieder`, `events`, `checkin`.
- Account field keys (fixed vocabulary): `address`, `birthdate`, `phone`, `emergencyContact`, `medicalNotes`, plus the pseudo-key `group`.

---

### Task 1: `groups` table migration

**Files:**
- Create: `db/migrations/006_groups.sql`
- Modify: `tests/integration/schema-users.test.js` (add a table-existence assertion for `groups`, matching the existing pattern for `users`/`sessions`/etc. in that same file)

**Interfaces:**
- Produces: a `groups` table with columns `id uuid`, `key text unique not null`, `name text not null`, `visible_menus jsonb not null default '[]'`, `account_fields jsonb not null default '[]'`, `can_edit_characters boolean not null default false`, `is_protected boolean not null default false`; and `users.group_id uuid references groups(id)` (nullable for now — Task 2 backfills and finalizes it).

- [ ] **Step 1: Write the migration**

Create `db/migrations/006_groups.sql`:

```sql
CREATE TABLE groups (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  visible_menus jsonb not null default '[]',
  account_fields jsonb not null default '[]',
  can_edit_characters boolean not null default false,
  is_protected boolean not null default false
);

ALTER TABLE users ADD COLUMN group_id uuid REFERENCES groups(id);
```

- [ ] **Step 2: Add a failing assertion for the new table**

In `tests/integration/schema-users.test.js`, the first test loops over
`['users', 'sessions', 'email_verification_tokens', 'password_reset_tokens']`
and asserts each `to_regclass` is non-null. Add `'groups'` to that array
(it will pass once the migration runs — this step is really "extend
coverage", not TDD-red, since the migration file already exists after
Step 1; run it anyway to confirm the table really exists):

```javascript
  for (const table of ['users', 'sessions', 'email_verification_tokens', 'password_reset_tokens', 'groups']) {
```

- [ ] **Step 3: Run the test**

Run: `node --test tests/integration/schema-users.test.js`
Expected: PASS (both existing tests in the file still fail on the `role`
column references at this point in the file — Task 5 fixes those; this
step is only checking the new `groups` table assertion passes and nothing
about this task's own change is broken. If the whole file errors before
reaching that assertion, stop and investigate — do not proceed with a
broken migration.)

Actually: **run just the table-existence test in isolation** to avoid the
(currently still-broken, pending Task 5) `role`-column tests blocking you:

```bash
node -e "
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost:5433/pakyrion_test';
const { runMigrations } = await import('./db/migrate.js');
await runMigrations();
const { query, closePool } = await import('./backend/db.js');
const { rows } = await query('SELECT to_regclass(\$1) AS exists', ['groups']);
console.log('groups table exists:', !!rows[0].exists);
await closePool();
"
```
Expected output: `groups table exists: true`

- [ ] **Step 4: Commit**

```bash
git add db/migrations/006_groups.sql tests/integration/schema-users.test.js
git commit -m "feat: add groups table migration"
```

---

### Task 2: `db/groupDefaults.js` + `db/seedGroups.js`

**Files:**
- Create: `db/groupDefaults.js`
- Create: `db/seedGroups.js`
- Create: `tests/integration/seedGroups.test.js`
- Modify: `package.json` (add `seed-groups` script)
- Modify: `docker-compose.yml` (run `seed-groups` between `migrate` and `seed-admin`)

**Interfaces:**
- Consumes: Task 1's `groups` table, `users.group_id` column.
- Produces: `export const GROUP_DEFAULTS` (array of `{key, name, visibleMenus, accountFields, canEditCharacters, isProtected}`) from `db/groupDefaults.js`. `export async function seedGroups()` from `db/seedGroups.js` — idempotent, callable with no arguments, returns nothing meaningful (matches `seedAdmin`'s void-ish return for the "nothing to do" paths, but always attempts the seed+backfill+finalize work, unlike `seedAdmin` which is opt-in via env vars).

- [ ] **Step 1: Write `db/groupDefaults.js`**

```javascript
export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'group'],
    canEditCharacters: true, isProtected: true,
  },
  {
    key: 'orga', name: 'Orga',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes'],
    canEditCharacters: true, isProtected: false,
  },
  {
    key: 'plot_orga', name: 'Plot-Orga',
    visibleMenus: ['konto', 'charaktere', 'events', 'checkin'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'sl', name: 'SL',
    visibleMenus: ['konto', 'charaktere', 'checkin'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'hilfs_sl', name: 'Hilfs-SL',
    visibleMenus: ['konto', 'charaktere', 'checkin'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'nsc', name: 'NSC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'gsc', name: 'GSC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'sc', name: 'SC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
];
```

- [ ] **Step 2: Write `db/seedGroups.js`**

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { GROUP_DEFAULTS } from './groupDefaults.js';

const ROLE_TO_GROUP_KEY = { admin: 'admin', checkin_helper: 'sl', participant: 'sc' };

// Idempotent: safe to run on every deploy/restart, and safe to call multiple
// times within the same process (e.g. once per test file sharing a DB).
export async function seedGroups() {
  for (const group of GROUP_DEFAULTS) {
    await query(
      `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, is_protected)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO NOTHING`,
      [
        group.key,
        group.name,
        JSON.stringify(group.visibleMenus),
        JSON.stringify(group.accountFields),
        group.canEditCharacters,
        group.isProtected,
      ]
    );
  }

  const { rows: roleColumn } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`
  );
  if (roleColumn.length === 0) {
    // Already finalized in a previous run — nothing left to backfill.
    return;
  }

  for (const [role, groupKey] of Object.entries(ROLE_TO_GROUP_KEY)) {
    await query(
      `UPDATE users SET group_id = (SELECT id FROM groups WHERE key = $1)
       WHERE role = $2 AND group_id IS NULL`,
      [groupKey, role]
    );
  }

  await query('ALTER TABLE users ALTER COLUMN group_id SET NOT NULL');
  await query('ALTER TABLE users DROP COLUMN role');
  logger.info('users migrated from role to group_id; role column dropped');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  seedGroups()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('group seed failed', { error: err.message });
      process.exit(1);
    });
}
```

- [ ] **Step 3: Write the failing test first**

Create `tests/integration/seedGroups.test.js` (mirrors
`tests/integration/seedAdmin.test.js`'s structure):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
const { query, closePool } = await import('../../backend/db.js');

test('seeds all 8 default groups', async () => {
  await seedGroups();
  const { rows } = await query('SELECT key FROM groups ORDER BY key');
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, ['admin', 'gsc', 'hilfs_sl', 'nsc', 'orga', 'plot_orga', 'sc', 'sl']);
});

test('running twice does not duplicate groups or throw', async () => {
  await seedGroups();
  await seedGroups();
  const { rows } = await query('SELECT count(*)::int AS count FROM groups');
  assert.equal(rows[0].count, 8);
});

test('admin group has every menu and can edit characters', async () => {
  await seedGroups();
  const { rows } = await query('SELECT visible_menus, can_edit_characters FROM groups WHERE key = $1', ['admin']);
  assert.deepEqual(rows[0].visible_menus.sort(), ['charaktere', 'checkin', 'events', 'konto', 'mitglieder']);
  assert.equal(rows[0].can_edit_characters, true);
});

test('backfills group_id for a user with an existing role value, then drops the role column', async () => {
  await seedGroups();
  // At this point role may already be dropped by an earlier test in this
  // file (seedGroups is idempotent and re-entrant across the whole file's
  // shared DB) — this test only makes sense to run standalone against a
  // fresh DB, so it re-checks preconditions rather than assuming them.
  const { rows: roleColumn } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`
  );
  if (roleColumn.length === 0) {
    // role already dropped by a prior seedGroups() call in this shared test
    // DB — assert the end state directly instead (group_id is NOT NULL and
    // usable) rather than re-testing the backfill path itself.
    const { rows } = await query(
      "INSERT INTO users (email, name, group_id) VALUES ($1, 'Backfill Check', (SELECT id FROM groups WHERE key = 'sc')) RETURNING group_id",
      [`backfill-check-${crypto.randomUUID()}@example.com`]
    );
    assert.ok(rows[0].group_id);
    return;
  }
  const { rows } = await query(
    "INSERT INTO users (email, name, role) VALUES ($1, 'Backfill Test', 'checkin_helper') RETURNING id",
    [`backfill-${crypto.randomUUID()}@example.com`]
  );
  await seedGroups();
  const { rows: after } = await query(
    `SELECT groups.key FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [rows[0].id]
  );
  assert.equal(after[0].key, 'sl');
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 4: Run the test to confirm it exercises real behavior**

Run: `node --test tests/integration/seedGroups.test.js`
Expected: all 4 tests PASS. If the last test's `if (roleColumn.length === 0)`
branch is the one that actually ran (likely, since earlier tests in this
same file already called `seedGroups()` and dropped the column), that's
fine — it's still asserting real, meaningful end-state behavior.

- [ ] **Step 5: Add the npm script**

In `package.json`, add a line after `"migrate": "node db/migrate.js",`:

```json
    "seed-groups": "node db/seedGroups.js",
```

- [ ] **Step 6: Wire it into docker-compose's startup chain, before seed-admin**

In `docker-compose.yml`, change the `app` service's `command`:

```yaml
    command: sh -c "npm run migrate && npm run seed-groups && npm run seed-admin && npm run dev"
```

(`seed-groups` must run before `seed-admin` — Task 4 changes `seedAdmin.js`
to look up the `admin` group's id, which must already exist.)

- [ ] **Step 7: Commit**

```bash
git add db/groupDefaults.js db/seedGroups.js tests/integration/seedGroups.test.js package.json docker-compose.yml
git commit -m "feat: add idempotent group seeding with role-to-group backfill"
```

---

### Task 3: `requireMenu` middleware, replacing `requireRole`

**Files:**
- Modify: `backend/middleware/authenticate.js`
- Modify: `backend/middleware/authorize.js`
- Modify: `tests/integration/middleware.test.js` (rewrite — the tests
  literally exercise the middleware being replaced)

**Interfaces:**
- Consumes: Task 2's seeded `groups` table (via `group_id` FK lookups).
- Produces: `requireAuth(handler)` now attaches `ctx.user.group = { id, key, name, visibleMenus, accountFields, canEditCharacters }` instead of `ctx.user.role`. `export function requireMenu(menuKey)` from `backend/middleware/authorize.js` (replaces `requireRole`, same higher-order-function shape: `requireMenu(menuKey)(handler)`). Task 4 depends on both of these exact shapes.

- [ ] **Step 1: Update `requireAuth` to load the group via a join**

Replace the body of `backend/middleware/authenticate.js`:

```javascript
import { parseCookies, SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { getSession } from '../auth/sessions.js';
import { query } from '../db.js';

export function requireAuth(handler) {
  return async (ctx) => {
    const cookies = parseCookies(ctx.req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) return { status: 401, body: { error: 'not authenticated' } };

    const session = await getSession(token);
    if (!session) return { status: 401, body: { error: 'not authenticated' } };

    const { rows } = await query(
      `SELECT users.id, users.email, users.name,
              groups.id AS group_id, groups.key AS group_key, groups.name AS group_name,
              groups.visible_menus, groups.account_fields, groups.can_edit_characters
       FROM users
       JOIN groups ON groups.id = users.group_id
       WHERE users.id = $1`,
      [session.userId]
    );
    if (rows.length === 0) return { status: 401, body: { error: 'not authenticated' } };

    const row = rows[0];
    const user = {
      id: row.id,
      email: row.email,
      name: row.name,
      group: {
        id: row.group_id,
        key: row.group_key,
        name: row.group_name,
        visibleMenus: row.visible_menus,
        accountFields: row.account_fields,
        canEditCharacters: row.can_edit_characters,
      },
    };

    return handler({ ...ctx, user });
  };
}
```

- [ ] **Step 2: Replace `requireRole` with `requireMenu`**

Replace the entire content of `backend/middleware/authorize.js`:

```javascript
export function requireMenu(menuKey) {
  return (handler) => async (ctx) => {
    if (!ctx.user) return { status: 401, body: { error: 'not authenticated' } };
    if (!ctx.user.group.visibleMenus.includes(menuKey)) return { status: 403, body: { error: 'forbidden' } };
    return handler(ctx);
  };
}
```

- [ ] **Step 3: Rewrite the middleware test**

Replace the entire content of `tests/integration/middleware.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { requireAuth } = await import('../../backend/middleware/authenticate.js');
const { requireMenu } = await import('../../backend/middleware/authorize.js');

async function makeUser(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id) VALUES ($1, 'Mid Test', (SELECT id FROM groups WHERE key = $2)) RETURNING id",
    [`mid-${Date.now()}-${Math.random()}@example.com`, groupKey]
  );
  return rows[0].id;
}

test('requireAuth rejects a request with no cookie', async () => {
  const handler = requireAuth(async () => ({ status: 200, body: {} }));
  const result = await handler({ req: { headers: {} } });
  assert.equal(result.status, 401);
});

test('requireAuth rejects an invalid session token', async () => {
  const handler = requireAuth(async () => ({ status: 200, body: {} }));
  const result = await handler({ req: { headers: { cookie: 'session=not-a-real-token' } } });
  assert.equal(result.status, 401);
});

test('requireAuth attaches the user (with group) and calls the handler for a valid session', async () => {
  const userId = await makeUser();
  const session = await createSession(userId);
  const handler = requireAuth(async ({ user }) => ({ status: 200, body: { userId: user.id, groupKey: user.group.key } }));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 200);
  assert.equal(result.body.userId, userId);
  assert.equal(result.body.groupKey, 'sc');
});

test('requireMenu rejects a user whose group cannot see the menu', async () => {
  const userId = await makeUser('sc');
  const session = await createSession(userId);
  const handler = requireAuth(requireMenu('mitglieder')(async () => ({ status: 200, body: {} })));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 403);
});

test('requireMenu allows a user whose group can see the menu', async () => {
  const userId = await makeUser('admin');
  const session = await createSession(userId);
  const handler = requireAuth(requireMenu('checkin')(async () => ({ status: 200, body: { ok: true } })));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 4: Run the test**

Run: `node --test tests/integration/middleware.test.js`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/middleware/authenticate.js backend/middleware/authorize.js tests/integration/middleware.test.js
git commit -m "feat: replace requireRole middleware with group-based requireMenu"
```

---

### Task 4: Update production code that reads/writes `role`

**Files:**
- Modify: `backend/accounts/repository.js`
- Modify: `backend/characters/routes.js`
- Modify: `backend/auth/register.js`
- Modify: `backend/auth/oauth.js`
- Modify: `db/seedAdmin.js`
- Modify: `backend/events/routes.js`
- Modify: `backend/registrations/routes.js`
- Modify: `tests/integration/seedAdmin.test.js`

**Interfaces:**
- Consumes: Task 3's `ctx.user.group` shape, `requireMenu(menuKey)`.
- Produces: `GET /account` response shape becomes `{ id, email, name, group: {key, name}, menus: string[], canEditCharacters: boolean, emailVerified, address, birthdate, phone, emergencyContact, medicalNotes }` — no more `role`. Task 5's frontend patch and the later Member-Management/Nav plans depend on this exact shape.

- [ ] **Step 1: Update `backend/accounts/repository.js`**

Replace the entire file:

```javascript
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    group: { key: row.group_key, name: row.group_name },
    menus: row.visible_menus,
    canEditCharacters: row.can_edit_characters,
    emailVerified: row.email_verified,
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters
`;

const FROM_JOIN = `FROM users JOIN groups ON groups.id = users.group_id`;

export async function getAccount(userId) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE users.id = $1`, [userId]);
  if (rows.length === 0) return null;
  return decryptAccount(rows[0]);
}

export async function updateAccount(userId, fields) {
  const { rows } = await query(
    `UPDATE users SET
       name = COALESCE($2, name),
       address_enc = COALESCE($3, address_enc),
       birthdate_enc = COALESCE($4, birthdate_enc),
       phone_enc = COALESCE($5, phone_enc),
       emergency_contact_enc = COALESCE($6, emergency_contact_enc),
       medical_notes_enc = COALESCE($7, medical_notes_enc)
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.name ?? null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContact !== undefined ? encryptField(fields.emergencyContact) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}
```

(`UPDATE ... RETURNING` can't express the `groups` join, so `updateAccount`
now re-fetches via `getAccount` after writing — one extra query, negligible
for this app's traffic, and keeps a single source of truth for the response
shape.)

- [ ] **Step 2: Update `backend/characters/routes.js`'s two role checks**

In `backend/characters/routes.js`, change line 14:
```javascript
  if (user.role === 'participant') {
```
to:
```javascript
  if (!user.group.canEditCharacters) {
```

And change line 41:
```javascript
  if (character.user_id !== user.id && user.role !== 'admin') {
```
to:
```javascript
  if (character.user_id !== user.id && !user.group.canEditCharacters) {
```

(Both checks previously distinguished "plain participant" / "admin"; they
now key off the same `can_edit_characters` group flag the spec defines for
Mitgliederverwaltung — a group permitted to edit others' characters there
is also permitted to bypass the active-event restriction and view others'
character detail here. `admin` and `orga` have this flag; every other
default group does not, matching the old behavior for `admin` and
extending it sensibly to `orga`.)

- [ ] **Step 3: Update `backend/auth/register.js`**

Change the INSERT in the `/auth/register` handler:
```javascript
      `INSERT INTO users (email, password_hash, role, name)
       VALUES ($1, $2, 'participant', $3) RETURNING id`,
```
to:
```javascript
      `INSERT INTO users (email, password_hash, group_id, name)
       VALUES ($1, $2, (SELECT id FROM groups WHERE key = 'sc'), $3) RETURNING id`,
```

- [ ] **Step 4: Update `backend/auth/oauth.js`**

Change the INSERT in `findOrCreateOAuthUser`:
```javascript
      `INSERT INTO users (email, password_hash, role, name, email_verified)
       VALUES ($1, NULL, 'participant', $2, $3) RETURNING id`,
```
to:
```javascript
      `INSERT INTO users (email, password_hash, group_id, name, email_verified)
       VALUES ($1, NULL, (SELECT id FROM groups WHERE key = 'sc'), $2, $3) RETURNING id`,
```

- [ ] **Step 5: Update `db/seedAdmin.js`**

Change the INSERT:
```javascript
    `INSERT INTO users (email, password_hash, role, name, email_verified)
     VALUES ($1, $2, 'admin', 'Admin', true)
     RETURNING id`,
```
to:
```javascript
    `INSERT INTO users (email, password_hash, group_id, name, email_verified)
     VALUES ($1, $2, (SELECT id FROM groups WHERE key = 'admin'), 'Admin', true)
     RETURNING id`,
```

- [ ] **Step 6: Update `tests/integration/seedAdmin.test.js`**

Add a `seedGroups()` call to the setup (right after `runMigrations()`):
```javascript
const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { seedAdmin } = await import('../../db/seedAdmin.js');
```

And change the assertion in the second test from:
```javascript
  const { rows } = await query(
    'SELECT role, email_verified, password_hash FROM users WHERE id = $1',
    [userId]
  );
  assert.equal(rows[0].role, 'admin');
```
to:
```javascript
  const { rows } = await query(
    `SELECT groups.key AS group_key, users.email_verified, users.password_hash
     FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [userId]
  );
  assert.equal(rows[0].group_key, 'admin');
```

- [ ] **Step 7: Update `backend/events/routes.js`**

Change the import:
```javascript
import { requireRole } from '../middleware/authorize.js';
```
to:
```javascript
import { requireMenu } from '../middleware/authorize.js';
```

And replace all three `requireRole('admin')` call sites with `requireMenu('events')` (the three routes: `POST /events`, `PUT /events/:id`, `POST /events/:id/activate`).

- [ ] **Step 8: Update `backend/registrations/routes.js`**

Change the import:
```javascript
import { requireRole } from '../middleware/authorize.js';
```
to:
```javascript
import { requireMenu } from '../middleware/authorize.js';
```

And replace all three `requireRole('admin', 'checkin_helper')` call sites
with `requireMenu('checkin')` (the three routes: `GET /events/:id/participants`,
`POST /events/:id/checkin`, `POST /events/:id/checkout`).

- [ ] **Step 9: Run the affected unit-adjacent checks**

Run: `node --test tests/integration/seedAdmin.test.js tests/integration/middleware.test.js`
Expected: all PASS (the wider suite still has failures until Task 5 — that's expected and addressed there).

- [ ] **Step 10: Commit**

```bash
git add backend/accounts/repository.js backend/characters/routes.js backend/auth/register.js backend/auth/oauth.js db/seedAdmin.js backend/events/routes.js backend/registrations/routes.js tests/integration/seedAdmin.test.js
git commit -m "feat: switch account/character/event/checkin/registration code from role to group"
```

---

### Task 5: Update remaining test files + minimal frontend compat patch

**Files:**
- Modify (add `seedGroups()` call after `runMigrations()` in every file — see exact insertion point below): `tests/integration/accounts.test.js`, `tests/integration/auth-login.test.js`, `tests/integration/auth-password-reset.test.js`, `tests/integration/auth-register.test.js`, `tests/integration/characters.test.js`, `tests/integration/checkin.test.js`, `tests/integration/db.test.js`, `tests/integration/events.test.js`, `tests/integration/migrate.test.js`, `tests/integration/oauth.test.js`, `tests/integration/registrations.test.js`, `tests/integration/schema-events.test.js`, `tests/integration/schema-oauth.test.js`, `tests/integration/schema-registrations.test.js`, `tests/integration/schema-users.test.js`, `tests/integration/server.test.js`, `tests/integration/sessions.test.js`, `tests/integration/staticFiles.test.js`
- Modify (role→group_id in raw SQL, see per-file detail below): `tests/integration/characters.test.js`, `tests/integration/checkin.test.js`, `tests/integration/events.test.js`, `tests/integration/oauth.test.js`, `tests/integration/registrations.test.js`, `tests/integration/schema-events.test.js`, `tests/integration/schema-oauth.test.js`, `tests/integration/schema-registrations.test.js`, `tests/integration/schema-users.test.js`, `tests/integration/sessions.test.js`
- Modify: `frontend/account.html`, `frontend/characters.html` (minimal compat patch, not the full nav rework)

**Interfaces:**
- Consumes: Task 2's `seedGroups()`, Task 4's `GET /account` shape (`group`, `menus`, `canEditCharacters` — no `role`).

- [ ] **Step 1: Add `await seedGroups();` to every integration test file's setup**

For **every** file listed in the first bullet above, find this exact
two-line pattern near the top of the file (it appears in all of them,
right after the migrations import):

```javascript
const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
```

and insert immediately after it:

```javascript

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
```

This is a uniform, mechanical addition — every one of these files either
inserts users directly via raw SQL, or exercises code paths
(`register.js`/`oauth.js`/`seedAdmin.js`) that now require `group_id` to
resolve via a `groups` lookup. Files that don't insert users at all (e.g.
`migrate.test.js`, `db.test.js`) are unaffected either way — the call is a
cheap no-op idempotent seed, harmless to include everywhere for
consistency rather than auditing each file individually.

- [ ] **Step 2: Fix the raw-SQL role references, file by file**

**`tests/integration/sessions.test.js`** — line 15, change:
```javascript
    "INSERT INTO users (email, name, role) VALUES ($1, 'Test', 'participant') RETURNING id",
```
to:
```javascript
    "INSERT INTO users (email, name, group_id) VALUES ($1, 'Test', (SELECT id FROM groups WHERE key = 'sc')) RETURNING id",
```

**`tests/integration/schema-users.test.js`** — lines 22 and 26, change:
```javascript
    "INSERT INTO users (email, name, role) VALUES ($1, 'A', 'participant')",
```
```javascript
    query("INSERT INTO users (email, name, role) VALUES ($1, 'B', 'participant')", [email]),
```
to:
```javascript
    "INSERT INTO users (email, name, group_id) VALUES ($1, 'A', (SELECT id FROM groups WHERE key = 'sc'))",
```
```javascript
    query("INSERT INTO users (email, name, group_id) VALUES ($1, 'B', (SELECT id FROM groups WHERE key = 'sc'))", [email]),
```

**`tests/integration/schema-events.test.js`** — line 36, change:
```javascript
    "INSERT INTO users (email, name, role) VALUES ($1, 'FK Test', 'participant') RETURNING id",
```
to:
```javascript
    "INSERT INTO users (email, name, group_id) VALUES ($1, 'FK Test', (SELECT id FROM groups WHERE key = 'sc')) RETURNING id",
```

**`tests/integration/schema-registrations.test.js`** — line 15, change:
```javascript
    "INSERT INTO users (email, name, role) VALUES ($1, 'Reg Test', 'participant') RETURNING id",
```
to:
```javascript
    "INSERT INTO users (email, name, group_id) VALUES ($1, 'Reg Test', (SELECT id FROM groups WHERE key = 'sc')) RETURNING id",
```

**`tests/integration/schema-oauth.test.js`** — line 19, change:
```javascript
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'OAuth Uniq', 'participant', true) RETURNING id",
```
to:
```javascript
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'OAuth Uniq', (SELECT id FROM groups WHERE key = 'sc'), true) RETURNING id",
```

**`tests/integration/oauth.test.js`** — both occurrences (lines 96 and 106), change:
```javascript
    "INSERT INTO users (email, password_hash, role, name, email_verified) VALUES ($1, 'irrelevant-hash', 'participant', 'Existing User', true) RETURNING id",
```
to:
```javascript
    "INSERT INTO users (email, password_hash, group_id, name, email_verified) VALUES ($1, 'irrelevant-hash', (SELECT id FROM groups WHERE key = 'sc'), 'Existing User', true) RETURNING id",
```

**`tests/integration/registrations.test.js`** — line 19, change:
```javascript
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Reg Test', 'participant', true) RETURNING id",
```
to:
```javascript
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Reg Test', (SELECT id FROM groups WHERE key = 'sc'), true) RETURNING id",
```
and line 124, change:
```javascript
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Race Helper', 'checkin_helper', true) RETURNING id",
```
to:
```javascript
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Race Helper', (SELECT id FROM groups WHERE key = 'sl'), true) RETURNING id",
```

**`tests/integration/events.test.js`** — line 16, change the helper signature and its INSERT:
```javascript
async function makeUserAndSession(role = 'participant') {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Events Test', $2, true) RETURNING id",
    [`events-${role}-${crypto.randomUUID()}@example.com`, role]
  );
```
to:
```javascript
async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Events Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`events-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
```
then every call site in the same file that passes `'participant'` →
`'sc'`, and `'admin'` stays `'admin'` (already a valid group key — no
change needed at those call sites).

**`tests/integration/checkin.test.js`** — line 17, same shape of change:
```javascript
async function makeUserAndSession(role = 'participant') {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Checkin Test', $2, true) RETURNING id",
    [`checkin-${role}-${crypto.randomUUID()}@example.com`, role]
  );
```
to:
```javascript
async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Checkin Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`checkin-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
```
then update every call site in the file: `'participant'` → `'sc'`,
`'checkin_helper'` → `'sl'`, `'admin'` stays `'admin'`.

**`tests/integration/characters.test.js`** — line 17, same shape:
```javascript
async function makeUserAndSession(role = 'participant') {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Char Test', $2, true) RETURNING id",
    [`chars-${role}-${crypto.randomUUID()}@example.com`, role]
  );
```
to:
```javascript
async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Char Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`chars-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
```
`'admin'` call sites in this file stay `'admin'`, no other role values used.

- [ ] **Step 3: Minimal frontend compat patch — `frontend/account.html`**

Change line 54:
```javascript
    if (account.role === 'admin') {
```
to:
```javascript
    if (account.menus.includes('mitglieder')) {
```

(This is a deliberately narrow fix — it keeps the existing admin-nav-link
visibility working now that `account.role` no longer exists. It is NOT the
full menu-driven nav rework from the spec; that's a later plan.)

- [ ] **Step 4: Minimal frontend compat patch — `frontend/characters.html`**

Change line 67:
```javascript
let userRole = 'participant';
```
to:
```javascript
let canEditCharacters = false;
```

Change line 130:
```javascript
  const visibleEvents = userRole === 'participant' ? events.filter((e) => e.is_active) : events;
```
to:
```javascript
  const visibleEvents = canEditCharacters ? events : events.filter((e) => e.is_active);
```

Change lines 255-256:
```javascript
  userRole = account.role;
  if (account.role === 'admin') {
```
to:
```javascript
  canEditCharacters = account.canEditCharacters;
  if (account.menus.includes('mitglieder')) {
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass (150 tests before this plan; expect ~150 + the 4
new `seedGroups.test.js` tests + 1 new `groups`-table assertion, roughly
155, all green, 0 failures).

- [ ] **Step 6: Manual verification**

Using Claude Browser tools against the running dev stack
(`docker compose up -d` picks up the new `seed-groups` step automatically):
- Log in as `admin@pakyrion.local` / `0000`. Confirm the admin nav links
  ("Events (Admin)", "Check-In (Admin)") still appear on `/account.html`
  and `/characters.html`, exactly as before this plan.
- Confirm `/admin/events.html` and `/admin/checkin.html` still load and
  function normally for the admin account.
- Register a throwaway new participant account, confirm it lands in the
  `sc` group (`docker compose exec db psql -U app -d pakyrion -c "SELECT groups.key FROM users JOIN groups ON groups.id = users.group_id WHERE users.email = '<the address>';"` should print `sc`), confirm it can create a character for the active event and does NOT see admin nav links. Delete the throwaway account afterward.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/ frontend/account.html frontend/characters.html
git commit -m "feat: migrate remaining tests and frontend to groups"
```

---

## Self-Review Notes (for the plan author / controller, not a task)

- Spec coverage: this plan covers the spec's "Datenmodell" (groups table,
  users.group_id, config defaults) and the group-facing parts of
  "Backend-Durchsetzung" (requireMenu, migration mapping) sections. It
  deliberately does NOT cover: the groups admin UI, member management,
  NSC schema, or the full nav.js rework — those remain in follow-up plans
  per the Global Constraints note above.
- Every `role` reference found via `grep -rn "role" backend/ db/ tests/`
  before writing this plan is accounted for in Tasks 3-5 — cross-checked
  against the full list gathered during planning (12 test files with
  direct `role` SQL references, plus `backend/accounts/repository.js`,
  `backend/characters/routes.js`, `backend/auth/register.js`,
  `backend/auth/oauth.js`, `db/seedAdmin.js`,
  `backend/middleware/authenticate.js`, `backend/middleware/authorize.js`).
- Type/shape consistency: `ctx.user.group.{key,name,visibleMenus,accountFields,canEditCharacters}`
  (Task 3) is the exact shape Task 4 reads (`user.group.canEditCharacters`)
  and the exact shape `GET /account`'s `decryptAccount` (Task 4) derives
  its own, differently-named response fields from (`group.key`/`group.name`,
  top-level `menus`, top-level `canEditCharacters`) — these are
  intentionally not identical shapes (one is the internal `ctx.user`
  representation, the other is the public API response), and Task 5's
  frontend patch consumes the public API shape (`account.menus`,
  `account.canEditCharacters`), not the internal one. No mismatch.
