# System- vs. Con-Rollen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the fused `groups` model (system rights + con-specific character-class permission) into two independent things: a 3-tier system role (`admin`/`moderator`/`mitglied`) on `users`/`invitations`, and a free-standing `con_role` (`sc`/`nsc`/`gsc`/`helfer`/`orga`/`hilfs_orga`) chosen per event registration.

**Architecture:** `groups.character_classes` is dropped; the 8 existing groups collapse into 3 (`admin` unchanged, `orga`/`plot_orga`/`sl`/`hilfs_sl` → `moderator`, `sc`/`gsc`/`nsc` → `mitglied`). A new `registrations.con_role` column (NOT NULL, CHECK-constrained) carries the per-event role. Self-service values (`sc`/`nsc`/`gsc`/`helfer`) are always settable; `orga`/`hilfs_orga` require the caller to already hold `orga`/`hilfs_orga` for that same event, or system role `moderator`/`admin`.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step.

**Spec:** `docs/superpowers/specs/2026-09-08-system-con-rollen-design.md`

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step — standing rule for every plan in this sequence.
- `moderator` gets the exact permission bundle `orga` has today (menus: konto/charaktere/mitglieder/events/checkin; `canEditCharacters=true`; `canOverrideCheckinStatus=true`; the same `accountFields` list as today's `orga`, i.e. without `'group'`) — `plot_orga`/`sl`/`hilfs_sl` users must not lose check-in access.
- Every group and character-class check that currently reads `user.group.characterClasses` must be removed, not just extended — that column no longer exists after Task 1.
- `db/groupDefaults.js` and `db/seedGroups.js` must always agree on the exact same 3 groups (an earlier plan in this sequence hit a real bug from these two drifting apart) — update both together, never one without the other.
- Dropping `groups.character_classes` and fixing every backend consumer of it (`authenticate.js`, `accounts/repository.js`, `groups/repository.js`/`routes.js`, `characters/routes.js`, `nscSchema/routes.js`) must happen in the SAME task — the column drop alone breaks `requireAuth` for every single authenticated request app-wide, so this cannot be split across a task boundary without leaving a task whose own deliverable is a fully broken app.
- `frontend/admin/members.html` needs no code change from this plan — its group dropdown already populates dynamically from `GET /groups`, so it automatically shows the 3 new groups once Task 1 lands.
- Every existing test must still pass; verify with each task's specified scope before the final full-suite gate.
- Verify visually via Claude Browser tools for every page touched.

---

### Task 1: Datenmodell + Backend — 3 System-Rollen, `characterClasses` entfernen

**Files:**
- Create: `db/migrations/027_system_con_rollen.sql`
- Modify: `db/groupDefaults.js`
- Modify: `db/seedGroups.js`
- Modify: `backend/groups/repository.js`
- Modify: `backend/groups/routes.js`
- Modify: `backend/middleware/authenticate.js`
- Modify: `backend/accounts/repository.js`
- Modify: `backend/characters/routes.js`
- Modify: `backend/nscSchema/routes.js`
- Modify: `tests/integration/schema-users.test.js`
- Modify: `tests/integration/groups.test.js`
- Modify: `tests/integration/accounts.test.js`
- Modify: `tests/integration/characters.test.js`
- Modify: every other file under `tests/` that hardcodes a legacy group key (found in Step 14)

**Interfaces:**
- Produces: exactly 3 rows in `groups` (`admin`, `moderator`, `mitglied`), no `character_classes` column anywhere in the schema or in `user.group`/`GET /account`. Produces: `registrations.con_role` (text, NOT NULL, `CHECK (con_role IN ('sc','nsc','gsc','helfer','orga','hilfs_orga'))`), populated but not yet enforced by application logic — consumed by Task 2's registration endpoints and Task 3's frontend.

- [ ] **Step 1: Write the migration**

Create `db/migrations/027_system_con_rollen.sql`:

```sql
-- 1. con_role column on registrations (nullable first, backfilled below from
--    the pre-migration group of each registration's user).
ALTER TABLE registrations ADD COLUMN con_role text
  CHECK (con_role IN ('sc', 'nsc', 'gsc', 'helfer', 'orga', 'hilfs_orga'));

UPDATE registrations r SET con_role = sub.mapped
FROM (
  SELECT u.id AS user_id, CASE g.key
    WHEN 'sc' THEN 'sc'
    WHEN 'gsc' THEN 'gsc'
    WHEN 'nsc' THEN 'nsc'
    WHEN 'orga' THEN 'orga'
    WHEN 'plot_orga' THEN 'orga'
    WHEN 'sl' THEN 'orga'
    WHEN 'hilfs_sl' THEN 'hilfs_orga'
    WHEN 'admin' THEN 'orga'
  END AS mapped
  FROM users u JOIN groups g ON g.id = u.group_id
) sub
WHERE r.user_id = sub.user_id AND r.con_role IS NULL;

ALTER TABLE registrations ALTER COLUMN con_role SET NOT NULL;

-- 2. New system-role groups (character_classes still exists at this point,
--    defaults to '[]' via its own column default so it doesn't need listing).
INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status, is_protected)
VALUES
  ('moderator', 'Moderator', '["konto","charaktere","mitglieder","events","checkin"]'::jsonb,
   '["address","birthdate","phone","emergencyContactLastName","emergencyContactFirstName","emergencyContactPhone","medicalNotes","conTage","accommodation","craftOffer","travelMethod","dataSharingOptOut","photoOptOut"]'::jsonb,
   true, true, false),
  ('mitglied', 'Mitglied', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, false, false)
ON CONFLICT (key) DO NOTHING;

-- 3. Remap users AND invitations off the 5 legacy non-admin groups before
--    deleting them (both tables have a NOT NULL FK to groups.id).
UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'moderator')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl'));

UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'mitglied')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('sc', 'gsc', 'nsc'));

UPDATE invitations SET group_id = (SELECT id FROM groups WHERE key = 'moderator')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl'));

UPDATE invitations SET group_id = (SELECT id FROM groups WHERE key = 'mitglied')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('sc', 'gsc', 'nsc'));

-- 4. Drop the now-orphaned legacy groups and the superseded column.
DELETE FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl', 'sc', 'gsc', 'nsc');

ALTER TABLE groups DROP COLUMN character_classes;
```

- [ ] **Step 2: Rewrite `db/groupDefaults.js`**

Replace the entire file:

```javascript
export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut', 'group'],
    canEditCharacters: true, canOverrideCheckinStatus: true, isProtected: true,
  },
  {
    key: 'moderator', name: 'Moderator',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut'],
    canEditCharacters: true, canOverrideCheckinStatus: true, isProtected: false,
  },
  {
    key: 'mitglied', name: 'Mitglied',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, canOverrideCheckinStatus: false, isProtected: false,
  },
];
```

- [ ] **Step 3: Update `db/seedGroups.js`**

Replace the entire file:

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { GROUP_DEFAULTS } from './groupDefaults.js';

// Idempotent: safe to run on every deploy/restart, and safe to call multiple
// times within the same process (e.g. once per test file sharing a DB).
export async function seedGroups() {
  for (const group of GROUP_DEFAULTS) {
    await query(
      `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status, is_protected)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO NOTHING`,
      [
        group.key,
        group.name,
        JSON.stringify(group.visibleMenus),
        JSON.stringify(group.accountFields),
        group.canEditCharacters,
        group.canOverrideCheckinStatus,
        group.isProtected,
      ]
    );
  }
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

- [ ] **Step 4: Rewrite `backend/groups/repository.js`**

```javascript
import { query } from '../db.js';

const SELECT_COLUMNS = 'id, key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status, is_protected';

export async function listGroups() {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups ORDER BY name`);
  return rows;
}

export async function getGroup(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createGroup({ key, name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus }) {
  const { rows } = await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [key, name, JSON.stringify(visibleMenus ?? []), JSON.stringify(accountFields ?? []), !!canEditCharacters, !!canOverrideCheckinStatus]
  );
  return rows[0];
}

export async function updateGroup(id, { name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus }) {
  const { rows } = await query(
    `UPDATE groups SET
       name = COALESCE($2, name),
       visible_menus = COALESCE($3, visible_menus),
       account_fields = COALESCE($4, account_fields),
       can_edit_characters = COALESCE($5, can_edit_characters),
       can_override_checkin_status = COALESCE($6, can_override_checkin_status)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      name ?? null,
      visibleMenus !== undefined ? JSON.stringify(visibleMenus) : null,
      accountFields !== undefined ? JSON.stringify(accountFields) : null,
      canEditCharacters !== undefined ? canEditCharacters : null,
      canOverrideCheckinStatus !== undefined ? canOverrideCheckinStatus : null,
    ]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 5: Rewrite `backend/groups/routes.js`**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listGroups, getGroup, createGroup, updateGroup } from './repository.js';
import { ACCOUNT_FIELD_KEYS } from '../accountFields.js';

const MENU_KEYS = ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'];
const KEY_PATTERN = /^[a-z0-9_]+$/;

function isValidMenuList(value) {
  return Array.isArray(value) && value.every((v) => MENU_KEYS.includes(v));
}

function isValidFieldList(value) {
  return Array.isArray(value) && value.every((v) => ACCOUNT_FIELD_KEYS.includes(v));
}

router.get('/groups', requireAuth(requireAdminGroup(async () => {
  const groups = await listGroups();
  return { status: 200, body: groups };
})));

router.post('/groups', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { key, name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus } = body;
  if (!key || !KEY_PATTERN.test(key)) {
    return { status: 400, body: { error: 'key is required and must contain only lowercase letters, digits, and underscores' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }
  if (visibleMenus !== undefined && !isValidMenuList(visibleMenus)) {
    return { status: 400, body: { error: `visibleMenus must be an array containing only: ${MENU_KEYS.join(', ')}` } };
  }
  if (accountFields !== undefined && !isValidFieldList(accountFields)) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${ACCOUNT_FIELD_KEYS.join(', ')}` } };
  }
  try {
    const group = await createGroup({ key, name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus });
    return { status: 201, body: group };
  } catch (err) {
    if (err.code === '23505') return { status: 409, body: { error: 'a group with this key already exists' } };
    throw err;
  }
})));

router.put('/groups/:id', requireAuth(requireAdminGroup(async ({ req, params }) => {
  const existing = await getGroup(params.id);
  if (!existing) return { status: 404, body: { error: 'group not found' } };
  if (existing.is_protected) {
    return { status: 403, body: { error: "the admin group's permissions cannot be edited" } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus } = body;
  if (visibleMenus !== undefined && !isValidMenuList(visibleMenus)) {
    return { status: 400, body: { error: `visibleMenus must be an array containing only: ${MENU_KEYS.join(', ')}` } };
  }
  if (accountFields !== undefined && !isValidFieldList(accountFields)) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${ACCOUNT_FIELD_KEYS.join(', ')}` } };
  }
  const group = await updateGroup(params.id, { name, visibleMenus, accountFields, canEditCharacters, canOverrideCheckinStatus });
  return { status: 200, body: group };
})));
```

- [ ] **Step 6: Remove `characterClasses` from `backend/middleware/authenticate.js`**

Find the `SELECT` inside `requireAuth` and remove `groups.character_classes` from the column list, and remove `characterClasses: row.character_classes,` from the returned `user.group` object. Every other line in the file stays unchanged.

- [ ] **Step 7: Remove `characterClasses` from `backend/accounts/repository.js`**

Remove `characterClasses: row.character_classes,` from `decryptAccount`'s return object, and remove `groups.character_classes` from `SELECT_COLUMNS`. Every other line stays unchanged.

- [ ] **Step 8: Remove the character-class permission check from `backend/characters/routes.js`**

In `POST /characters`, delete these lines entirely:

```javascript
  if (!user.group.characterClasses.includes(characterClass)) {
    return { status: 403, body: { error: 'forbidden' } };
  }
```

Every other line in that handler (the `class` validation, the `eventId`/`is_active` logic for `sc`) stays unchanged — every authenticated user may now create either class.

- [ ] **Step 9: Simplify the permission gate in `backend/nscSchema/routes.js`**

Change:

```javascript
router.get('/nsc-schema', requireAuth(async ({ user }) => {
  if (user.group.key !== 'admin' && !user.group.characterClasses.includes('nsc')) {
    return { status: 403, body: { error: 'forbidden' } };
  }
```

to:

```javascript
router.get('/nsc-schema', requireAuth(async () => {
```

(Every authenticated user may now read the NSC schema — it's the form structure, not personal data.)

- [ ] **Step 10: Fix `tests/integration/schema-users.test.js`**

Replace the test `'every group except nsc has "sc" in character_classes; nsc has "nsc" after migration'` with:

```javascript
test('exactly 3 groups exist after migration: admin, moderator, mitglied', async () => {
  const { rows } = await query('SELECT key FROM groups ORDER BY key');
  assert.deepEqual(rows.map((r) => r.key), ['admin', 'mitglied', 'moderator']);
});

test('registrations.con_role is backfilled and NOT NULL after migration', async () => {
  const { rows } = await query(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'registrations' AND column_name = 'con_role'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_nullable, 'NO');
});
```

Replace the test `'admin, orga, and sl groups have can_override_checkin_status=true after migration; others false'` with:

```javascript
test('admin and moderator have can_override_checkin_status=true after migration; mitglied false', async () => {
  const { rows } = await query('SELECT key, can_override_checkin_status FROM groups WHERE key = ANY($1)', [SEEDED_GROUP_KEYS]);
  for (const row of rows) {
    const expected = ['admin', 'moderator'].includes(row.key);
    assert.equal(row.can_override_checkin_status, expected, `${row.key} should have can_override_checkin_status=${expected}`);
  }
});
```

(`SEEDED_GROUP_KEYS` is already derived from `GROUP_DEFAULTS` at the top of the file — no change needed there, it now resolves to `['admin', 'moderator', 'mitglied']` automatically.)

- [ ] **Step 11: Fix `tests/integration/groups.test.js`**

Read the file first. Update the test asserting `'GET /groups returns all 8 seeded groups for an admin'` to expect 3 groups instead of 8 (rename it to `'GET /groups returns all 3 seeded groups for an admin'`).

Remove the two `characterClasses`-specific tests entirely: `'POST /groups accepts and returns characterClasses; PUT /groups/:id updates them'` and `'POST /groups rejects an invalid characterClasses value'` — the field no longer exists on `groups`.

Every `makeUserAndSession(groupKey)` call in this file that passes `'sc'`, `'nsc'`, `'gsc'`, `'orga'`, `'plot_orga'`, `'sl'`, or `'hilfs_sl'` must change: replace `'sc'`/`'nsc'`/`'gsc'` with `'mitglied'`, replace `'orga'`/`'plot_orga'`/`'sl'`/`'hilfs_sl'` with `'moderator'`, keep `'admin'` unchanged. Also change the helper's own default parameter (`groupKey = 'sc'`) to `groupKey = 'mitglied'`.

- [ ] **Step 12: Fix `tests/integration/accounts.test.js`**

Remove the test `'GET /account includes characterClasses from the caller\'s group'` entirely — the field no longer exists. Apply the same `makeUserAndSession`/default-parameter key rename described in Step 11 to every call in this file.

- [ ] **Step 13: Fix `tests/integration/characters.test.js`**

Remove the test `'a group without nsc character-class access cannot create an nsc-class character'` entirely — no longer true, any authenticated user may create either class. Apply the same `makeUserAndSession`/default-parameter key rename described in Step 11 to every call in this file (including inside the new-NSC-character tests — a plain `'mitglied'` user creating an NSC character is exactly what this plan is meant to allow).

- [ ] **Step 14: Rename every other test file's hardcoded legacy group key**

Run this to find every remaining reference outside the 4 files already handled above:

```bash
grep -rlE "key = '(sc|gsc|nsc|orga|plot_orga|sl|hilfs_sl)'|makeUserAndSession\('(sc|gsc|nsc|orga|plot_orga|sl|hilfs_sl)'\)" tests/ | grep -vE "groups\.test\.js|schema-users\.test\.js|characters\.test\.js|accounts\.test\.js"
```

For every file this lists, apply the exact same mapping as Step 11 to each match (do NOT touch anything under `db/migrations/` — those are historical and immutable):

- `'sc'`, `'gsc'`, `'nsc'` → `'mitglied'`. Before replacing, confirm from context that it's just standing in for "a plain, unprivileged registered user" (true for every remaining call in this codebase — the files with genuinely class-specific test intent, `characters.test.js`/`nscSchema.test.js`/`groups.test.js`, are excluded above).
- `'orga'`, `'plot_orga'`, `'sl'`, `'hilfs_sl'` → `'moderator'`. Confirm it's standing in for "a privileged, check-in/character-editing-capable user".
- `'admin'` → leave unchanged.

After editing, re-run the grep above — it must return zero files (besides the 4 excluded ones, which are already correct from Steps 11-13).

- [ ] **Step 15: Run the full test suite**

Run: `npm test`
Expected: all PASS. This is the full suite, not a scoped subset — given the scale of this rename (potentially a dozen-plus files touched in Step 14), catching a missed rename now is far cheaper than discovering it after Task 2/3 have already built on top of it.

- [ ] **Step 16: Verify visually**

Using Claude Browser tools against the running dev stack: log in as an admin, go to `/admin/groups.html` — confirm the list shows exactly 3 rows (Admin/Moderator/Mitglied), admin's row stays read-only, no "Darf Charakter-Klassen anlegen" section is present (that removal is actually Task 3's job — if it's still there, that's fine, just don't expect it gone yet). Go to `/characters.html` as any user — the page may look unchanged or partially odd here (Task 3 removes the now-dead `characterClasses`-based show/hide logic); note anything broken but don't fix it in this task.

- [ ] **Step 17: Commit**

```bash
git add -A
git commit -m "feat: reduce groups to 3 system roles (admin/moderator/mitglied), remove character_classes"
```

---

### Task 2: Backend — `con_role` bei der Event-Anmeldung

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Modify: `tests/integration/registrations.test.js`

**Interfaces:**
- Consumes: `registrations.con_role` (Task 1), `user.group.key`/`user.group.canOverrideCheckinStatus` (unchanged shape, now one of `admin`/`moderator`/`mitglied`).
- Produces: `registerForEvent(userId, eventId, conRole, requestingUser)` (was `(userId, eventId)`) — throws `err.code === 'FORBIDDEN_CON_ROLE'` for an unauthorized `orga`/`hilfs_orga` request. Produces: `export async function setConRole(eventId, userId, conRole, requestingUser)` — same forbidden-error contract, used by the new promotion endpoint.

- [ ] **Step 1: Add a shared permission helper and update `registerForEvent`**

In `backend/registrations/repository.js`, add near the top (after the imports):

```javascript
const SELF_SERVICE_CON_ROLES = ['sc', 'nsc', 'gsc', 'helfer'];
const STAFF_CON_ROLES = ['orga', 'hilfs_orga'];
const ALL_CON_ROLES = [...SELF_SERVICE_CON_ROLES, ...STAFF_CON_ROLES];

// Orga/Hilfs-Orga may only be granted by someone who is already orga/hilfs_orga
// for THIS SAME event, or who holds system role moderator/admin.
async function canGrantStaffConRole(eventId, requestingUser) {
  if (requestingUser.group.key === 'admin' || requestingUser.group.key === 'moderator') return true;
  const { rows } = await query(
    "SELECT 1 FROM registrations WHERE event_id = $1 AND user_id = $2 AND con_role IN ('orga', 'hilfs_orga')",
    [eventId, requestingUser.id]
  );
  return rows.length > 0;
}
```

Change `registerForEvent`'s signature and body:

```javascript
export async function registerForEvent(userId, eventId, conRole, requestingUser) {
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

  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id, con_role)
       VALUES ($1, $2, $3)
       RETURNING user_id, event_id, status, con_role, checked_in_at, checked_out_at`,
      [userId, eventId, conRole]
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
```

- [ ] **Step 2: Add `setConRole` (the promotion function)**

Add to `backend/registrations/repository.js`, after `registerForEvent`:

```javascript
export async function setConRole(eventId, userId, conRole, requestingUser) {
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
  const { rows } = await query(
    `UPDATE registrations SET con_role = $3
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, checked_in_at, checked_out_at`,
    [eventId, userId, conRole]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}
```

- [ ] **Step 3: Fix the `approveRegistration` character requirement**

Change `approveRegistration` to skip the character check for staff con-roles:

```javascript
export async function approveRegistration(eventId, userId) {
  const { rows: regRows } = await query(
    'SELECT con_role FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId]
  );
  if (regRows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  if (!STAFF_CON_ROLES.includes(regRows[0].con_role)) {
    const { rows: charRows } = await query(
      'SELECT 1 FROM characters WHERE event_id = $1 AND user_id = $2 LIMIT 1',
      [eventId, userId]
    );
    if (charRows.length === 0) {
      const err = new Error('cannot approve: no character assigned for this event');
      err.code = 'NO_CHARACTER';
      throw err;
    }
  }
  return transitionStatus(eventId, userId, 'approve');
}
```

- [ ] **Step 4: Include `con_role` in `listParticipantsForEvent` and `getScanLookup`**

In `listParticipantsForEvent`, add `r.con_role` to the registrations `SELECT`:

```javascript
  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.checked_in_at, r.checked_out_at${otColumnsSql}
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
```

and add `conRole: r.con_role,` to the mapped `registered` array's objects (right after `status: r.status,`).

In `getScanLookup`, add `r.con_role` to the `SELECT` and `conRole: r.con_role,` to the returned object (right after `status: r.status,`):

```javascript
export async function getScanLookup(eventId, userId) {
  const { rows } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, g.key AS group_key, r.status, r.con_role
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
    conRole: r.con_role,
    characters: characters.map((c) => ({ id: c.id, name: c.name })),
  };
}
```

- [ ] **Step 5: Update `backend/registrations/routes.js`**

Change the register handler to read `conRole` from the body and pass `user` through:

```javascript
router.post('/events/:id/register', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await registerForEvent(user.id, params.id, body.conRole, user);
    return { status: 201, body: registration };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'ALREADY_REGISTERED') return { status: 409, body: { error: err.message } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    throw err;
  }
}));
```

Add the import for `setConRole` alongside the existing repository imports, and add the new promotion endpoint after the existing `PUT /events/:id/checkin/:userId` route:

```javascript
router.put('/events/:id/registrations/:userId/con-role', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await setConRole(params.id, params.userId, body.conRole, user);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'INVALID_CON_ROLE') return { status: 400, body: { error: err.message } };
    if (err.code === 'FORBIDDEN_CON_ROLE') return { status: 403, body: { error: err.message } };
    throw err;
  }
}));
```

(Deliberately no `requireMenu('checkin')` gate on this endpoint — a plain `mitglied`-tier user who already holds `orga`/`hilfs_orga` for this specific event must be able to call it too, and that check lives inside `setConRole`/`canGrantStaffConRole` itself, not in menu visibility.)

- [ ] **Step 6: Write the failing tests**

Add to `tests/integration/registrations.test.js` (append, before any `test.after` block; read the file first for its exact `makeUserAndSession`/`makeEvent` helper signatures and adapt):

```javascript
test('a participant can self-register with a self-service con_role (sc/nsc/gsc/helfer)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.conRole ?? body.con_role, 'helfer');
  });
});

test('a plain member cannot self-register with con_role orga', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'orga' }),
    });
    assert.equal(res.status, 403);
  });
});

test('a moderator can self-register with con_role orga', async () => {
  await withTestServer(async (port) => {
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mod', 'Test', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`mod-${crypto.randomUUID()}@example.com`]
    );
    const session = await createSession(rows[0].id);
    const cookie = `session=${session.token}`;
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'orga' }),
    });
    assert.equal(res.status, 201);
  });
});

test('an event-scoped orga can promote another participant to hilfs_orga; a non-orga participant cannot', async () => {
  await withTestServer(async (port) => {
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');

    async function makeMitglied() {
      const { rows } = await query(
        "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'M', 'T', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
        [`mitglied-${crypto.randomUUID()}@example.com`]
      );
      const session = await createSession(rows[0].id);
      return { userId: rows[0].id, cookie: `session=${session.token}` };
    }

    const orga = await makeMitglied();
    const target = await makeMitglied();
    const bystander = await makeMitglied();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: orga.cookie },
      body: JSON.stringify({ conRole: 'orga' }),
    });
    await query(
      "UPDATE registrations SET con_role = 'orga' WHERE event_id = $1 AND user_id = $2",
      [eventId, orga.userId]
    );
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: target.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const promoted = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${target.userId}/con-role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: orga.cookie },
      body: JSON.stringify({ conRole: 'hilfs_orga' }),
    });
    assert.equal(promoted.status, 200);
    assert.equal((await promoted.json()).con_role, 'hilfs_orga');

    const denied = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${target.userId}/con-role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'orga' }),
    });
    assert.equal(denied.status, 403);
  });
});

test('approving a registration with con_role helfer succeeds without a character', async () => {
  await withTestServer(async (port) => {
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mod', 'Approve', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`mod-approve-${crypto.randomUUID()}@example.com`]
    );
    const modSession = await createSession(rows[0].id);
    const modCookie = `session=${modSession.token}`;
    const helferUser = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helferUser.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: modCookie },
      body: JSON.stringify({ userId: helferUser.userId }),
    });
    assert.equal(res.status, 200);
  });
});
```

Every other existing test in this file that calls `POST /events/:id/register` without a `conRole` body will now fail (`conRole must be one of: ...`) — read the whole file and add `body: JSON.stringify({ conRole: 'sc' })` (with the `'Content-Type': 'application/json'` header) to every such call. Also apply this file's `makeUserAndSession`'s hardcoded `key = 'sc'` → `key = 'mitglied'` rename (Task 1 Step 14 should already have caught this file via the grep — if it's already renamed, skip; if not, do it now).

- [ ] **Step 7: Run the tests**

Run: `node --test tests/integration/registrations.test.js tests/integration/schema-registrations.test.js`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js tests/integration/registrations.test.js
git commit -m "feat: add con_role to event registration, gated on same-event orga/hilfs_orga or moderator/admin"
```

---

### Task 3: Frontend + voller Testlauf

**Files:**
- Modify: `frontend/admin/groups.html`
- Modify: `frontend/characters.html`
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `POST /events/:id/register` now requiring `conRole` (Task 2), `PUT /events/:id/registrations/:userId/con-role` (Task 2), participant `conRole`/`con_role` fields from `GET /events/:id/participants` (Task 2).

- [ ] **Step 1: Remove the character-class checkboxes from `frontend/admin/groups.html`**

Delete this block entirely (between the `field-checkboxes` block and the `can-override-checkin-status` block):

```html
        <h3>Darf Charakter-Klassen anlegen</h3>
        <div class="checkbox-group" id="class-checkboxes">
          <label><input type="checkbox" value="sc" checked> SC (inkl. GSC)</label>
          <label><input type="checkbox" value="nsc"> NSC</label>
        </div>
```

In the script, remove `setCheckedValues('class-checkboxes', group.character_classes);` from `startEdit`, and remove `characterClasses: getCheckedValues('class-checkboxes'),` from the submit handler's `payload` object.

- [ ] **Step 2: `frontend/characters.html` — always show both sections, add `con_role` to registration**

Change the final `try` block's gating (remove the `characterClasses`-based `if`s, both sections show unconditionally):

```javascript
try {
  const account = await api.get('/account');
  canEditCharacters = account.canEditCharacters;
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  scFormSection.style.display = '';
  nscSchema = await api.get('/nsc-schema');
  nscSection.style.display = '';
  renderNscSchemaFields();
  isModeratorOrAdmin = account.group?.key === 'admin' || account.group?.key === 'moderator';
  await loadEvents();
  await loadCharacters();
  await loadRegistrations();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
```

Add `let isModeratorOrAdmin = false;` near the other top-level `let` declarations (next to `let canEditCharacters = false;`).

Add a con-role `<select>` next to the register button. Change:

```html
    <p>
      <button type="button" id="register-button">Für ausgewähltes Event anmelden</button>
    </p>
```

to:

```html
    <p>
      <label for="register-con-role">Rolle</label>
      <select id="register-con-role">
        <option value="sc">SC</option>
        <option value="nsc">NSC</option>
        <option value="gsc">GSC</option>
        <option value="helfer">Helfer</option>
        <option value="orga" data-staff-only>Orga</option>
        <option value="hilfs_orga" data-staff-only>Hilfs-Orga</option>
      </select>
      <button type="button" id="register-button">Anmelden</button>
    </p>
```

In the script, after loading the account (inside the same `try` block, after `isModeratorOrAdmin` is set), hide the staff-only options for non-privileged users:

```javascript
  if (!isModeratorOrAdmin) {
    document.querySelectorAll('#register-con-role option[data-staff-only]').forEach((opt) => opt.remove());
  }
```

Change the register button's click handler to send `conRole` and to name the target event in the button label. Replace:

```javascript
document.getElementById('register-button').addEventListener('click', async () => {
  registrationMessage.textContent = '';
  registrationMessage.className = '';
  const eventId = eventSelect.value;
  if (!eventId) return;
  try {
    await api.post(`/events/${eventId}/register`);
    registrationMessage.textContent = 'Angemeldet.';
    registrationMessage.className = 'success';
    await loadRegistrations();
  } catch (err) {
    registrationMessage.textContent = err.message;
    registrationMessage.className = 'error';
  }
});
```

with:

```javascript
const registerButton = document.getElementById('register-button');
const registerConRoleSelect = document.getElementById('register-con-role');

function updateRegisterButtonLabel() {
  const event = events.find((e) => e.id === eventSelect.value);
  registerButton.textContent = event ? `Anmelden für ${event.name}` : 'Anmelden';
}

eventSelect.addEventListener('change', updateRegisterButtonLabel);

registerButton.addEventListener('click', async () => {
  registrationMessage.textContent = '';
  registrationMessage.className = '';
  const eventId = eventSelect.value;
  if (!eventId) return;
  try {
    await api.post(`/events/${eventId}/register`, { conRole: registerConRoleSelect.value });
    registrationMessage.textContent = 'Angemeldet.';
    registrationMessage.className = 'success';
    await loadRegistrations();
  } catch (err) {
    registrationMessage.textContent = err.message;
    registrationMessage.className = 'error';
  }
});
```

Call `updateRegisterButtonLabel()` once at the end of `populateEventOptions()` (so the button already shows the right event name once events are loaded, not only after the user touches the dropdown):

```javascript
function populateEventOptions() {
  const visibleEvents = canEditCharacters ? events : events.filter((e) => e.is_active);
  eventSelect.innerHTML = renderEventOptions(visibleEvents);
  if (visibleEvents.length > 0) {
    renderSchemaFields(visibleEvents[0].character_form_schema);
  } else {
    dynamicFields.innerHTML = '';
  }
  updateRegisterButtonLabel();
}
```

- [ ] **Step 3: `frontend/admin/checkin.html` — show `con_role` in the participant table**

Change `renderTableHead` to add a "Rolle" column right after "Charaktere":

```javascript
function renderTableHead() {
  const itLabels = selectedColumns.it.map((key) => currentSchema.find((f) => f.key === key)?.label ?? key);
  const otLabels = selectedColumns.ot.map((key) => ACCOUNT_FIELD_LABELS[key] ?? key);
  const extraTh = [...itLabels, ...otLabels].map((label) => `<th>${escapeHtml(label)}</th>`).join('');
  tableHeadRow.innerHTML = `<th>Name</th><th>Charaktere</th><th>Rolle</th>${extraTh}<th>Status</th><th></th><th>Override</th>`;
}
```

Add a `CON_ROLE_LABELS` constant near the top of the script (alongside the other label constants such as `STATUS_LABELS`'s import):

```javascript
const CON_ROLE_LABELS = { sc: 'SC', nsc: 'NSC', gsc: 'GSC', helfer: 'Helfer', orga: 'Orga', hilfs_orga: 'Hilfs-Orga' };
```

Add a con-role cell + promotion control, right after `renderOverrideCell`:

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

(Only offers promotion among `helfer`/`hilfs_orga`/`orga` — reassigning someone's `sc`/`nsc`/`gsc` role here isn't part of this plan's scope; those are set once at self-registration. Only shown to `canOverride` users, i.e. `moderator`/`admin` today — a same-event `orga` who is otherwise a plain `mitglied` isn't yet reachable through this page, since `checkin.html` itself requires the `checkin` menu; that's a known, deliberate gap for this plan, not a bug — flag it in the final summary as a follow-up.)

Wire it into `loadParticipants`, both the row template and the change listener. Change:

```javascript
  listBody.innerHTML = participants.map((p) => `<tr>
    <td>${escapeHtml(p.name)}</td>
    <td>${escapeHtml(p.characters.map((c) => c.name).join(', '))}</td>
    ${renderExtraCells(p)}
    <td><span class="status-pill status-${escapeHtml(p.status)}">${escapeHtml(STATUS_LABELS[p.status] ?? p.status)}</span></td>
    <td>${renderActionCell(p)}</td>
    <td>${renderOverrideCell(p)}</td>
  </tr>`).join('');
```

to:

```javascript
  listBody.innerHTML = participants.map((p) => `<tr>
    <td>${escapeHtml(p.name)}</td>
    <td>${escapeHtml(p.characters.map((c) => c.name).join(', '))}</td>
    <td>${renderConRoleCell(p)}</td>
    ${renderExtraCells(p)}
    <td><span class="status-pill status-${escapeHtml(p.status)}">${escapeHtml(STATUS_LABELS[p.status] ?? p.status)}</span></td>
    <td>${renderActionCell(p)}</td>
    <td>${renderOverrideCell(p)}</td>
  </tr>`).join('');
```

and add, next to the existing `listBody.querySelectorAll('[data-override]')...` wiring:

```javascript
  listBody.querySelectorAll('[data-con-role]').forEach((select) => {
    select.addEventListener('change', () => promoteConRole(eventId, select.dataset.conRole, select.value));
  });
```

Add a `promoteConRole` function near `overrideStatus` (same file), matching that function's exact error-handling shape (shared `message` element, reload the row on both success and failure):

```javascript
async function promoteConRole(eventId, userId, conRole) {
  message.textContent = '';
  message.className = '';
  try {
    await api.put(`/events/${eventId}/registrations/${userId}/con-role`, { conRole });
    await loadParticipants(eventId);
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
    await loadParticipants(eventId);
  }
}
```

Update `applySearchFilter`'s row-text lookup, which currently reads `row.cells[0]`/`row.cells[1]` (Name/Charaktere) — the new "Rolle" column shifts every subsequent `<td>` index by one, but `applySearchFilter` only reads cells 0 and 1, which are unaffected, so no change needed there. Double check this against the actual file before moving on: search for any other place indexing `row.cells[N]` with `N >= 2` and adjust by +1 if any exist.

- [ ] **Step 4: Verify visually**

Using Claude Browser tools against the running dev stack:
1. Log in as a plain `mitglied`-tier user, go to `/characters.html` — confirm both "Neuen Charakter erstellen" (SC) and the NSC section are visible, the role `<select>` next to the register button shows only SC/NSC/GSC/Helfer (no Orga/Hilfs-Orga options), and the register button's label updates to `Anmelden für <Event-Name>` when an event is picked.
2. Register for an event as `helfer`, confirm the "Meine Anmeldungen" table shows the new registration.
3. Log in as `admin`, go to `/admin/checkin.html` for that event — confirm the participant row shows "Rolle: Helfer" with a working promotion dropdown, change it to "Hilfs-Orga", reload, confirm it persisted.
4. Go to `/admin/groups.html` — confirm the character-class checkboxes are gone and the 3-row list still edits/saves correctly.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests PASS (no regressions anywhere in the suite, not just the files this plan touched).

- [ ] **Step 6: Commit**

```bash
git add frontend/admin/groups.html frontend/characters.html frontend/admin/checkin.html
git commit -m "feat: frontend for con_role selection at registration and staff promotion in check-in"
```
