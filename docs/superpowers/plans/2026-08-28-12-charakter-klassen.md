# Charakter-Klassen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify SC- and NSC-Charaktere into one `characters`-backed model with a `class` discriminator, make character-class access a per-group setting instead of a hardcoded `'nsc'` string check, allow multiple characters per user/event ("Ersatzcharaktere"), and close a schema-field name-collision gap along the way (same validation pipeline both features touch).

**Architecture:** `characters.class` (`'sc'`/`'nsc'`) plus a nullable `event_id` unify the two previously-separate character concepts (event-bound SC characters, account-level NSC profile) into one table and one CRUD API. `groups.character_classes` (a JSON array, same pattern as `visible_menus`/`account_fields`) makes "who may create which class" configurable per group instead of hardcoded. The existing `nsc_profile_schema` table stays as the NSC class's global, event-independent schema — only where a user's NSC *data* lives changes (`users.nsc_data` → `characters` rows).

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step.

**Spec:** `docs/superpowers/specs/2026-08-28-charakterklassen-und-hardening-design.md` (Abschnitt 1 + 2; extends `docs/superpowers/specs/2026-08-27-sc-nsc-profilfelder-design.md` and `docs/superpowers/specs/2026-08-26-gruppen-berechtigungen-design.md`)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step — standing rule for every plan in this sequence.
- No uniqueness constraint on `(user_id, event_id)` for characters — multiple characters per user per event are explicitly wanted ("Ersatzcharaktere").
- NSC-Klassen-Charaktere are account-wide and event-independent (no `event_id`), per the spec's explicit decision.
- Character-class access (`groups.character_classes`) must default to preserve existing behavior: every group except a fresh install's non-`nsc` default keeps `'sc'` access (today ANY authenticated user can create SC characters) — only `nsc` access is a genuinely new restriction, defaulting to the `nsc` group only.
- Every existing test must still pass; verify with each task's specified scope before the final full-suite gate.
- Verify visually via Claude Browser tools for every page touched.

---

### Task 1: Namenskollisionsschutz — gemeinsame Schema-Shape-Validierung

**Files:**
- Modify: `backend/events/schemaValidation.js`
- Modify: `backend/events/routes.js`
- Modify: `backend/nscSchema/routes.js`
- Modify: `tests/unit/schemaValidation.test.js`
- Modify: `tests/integration/events.test.js`
- Modify: `tests/integration/nscSchema.test.js`

**Interfaces:**
- Produces: `export function validateSchemaShape(schema)` from `backend/events/schemaValidation.js` — returns `boolean`. Same contract as the two functions it replaces (`isValidCharacterFormSchema` in `events/routes.js`, `isValidSchemaShape` in `nscSchema/routes.js`), so both call sites just import instead of defining locally. Rejects: non-array input, any field missing a non-empty string `key`, any field whose `key` is `'id'` or `'name'`, and any schema with two fields sharing the same `key`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/schemaValidation.test.js` (append at the end, keep the existing `import` line and add `validateSchemaShape` to it):

```javascript
import { validateCharacterData, validateSchemaShape } from '../../backend/events/schemaValidation.js';
```

(Replace the existing `import { validateCharacterData } from '../../backend/events/schemaValidation.js';` line with the one above.)

```javascript
test('validateSchemaShape accepts a well-formed schema', () => {
  assert.equal(validateSchemaShape([
    { key: 'klasse', label: 'Klasse', type: 'text' },
    { key: 'volk', label: 'Volk', type: 'text' },
  ]), true);
});

test('validateSchemaShape accepts an empty schema', () => {
  assert.equal(validateSchemaShape([]), true);
});

test('validateSchemaShape rejects a non-array', () => {
  assert.equal(validateSchemaShape({ key: 'x' }), false);
  assert.equal(validateSchemaShape(null), false);
  assert.equal(validateSchemaShape('x'), false);
});

test('validateSchemaShape rejects a field with a missing or empty key', () => {
  assert.equal(validateSchemaShape([{ label: 'No key', type: 'text' }]), false);
  assert.equal(validateSchemaShape([{ key: '', label: 'Empty key', type: 'text' }]), false);
});

test('validateSchemaShape rejects the reserved keys "id" and "name"', () => {
  assert.equal(validateSchemaShape([{ key: 'id', label: 'Id', type: 'text' }]), false);
  assert.equal(validateSchemaShape([{ key: 'name', label: 'Name', type: 'text' }]), false);
  assert.equal(validateSchemaShape([{ key: 'klasse', label: 'Klasse', type: 'text' }, { key: 'id', label: 'Id', type: 'text' }]), false);
});

test('validateSchemaShape rejects duplicate keys within one schema', () => {
  assert.equal(validateSchemaShape([
    { key: 'klasse', label: 'Klasse', type: 'text' },
    { key: 'klasse', label: 'Klasse (2)', type: 'text' },
  ]), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/schemaValidation.test.js`
Expected: FAIL — `validateSchemaShape is not a function` or similar (not exported yet).

- [ ] **Step 3: Implement `validateSchemaShape`**

Add to `backend/events/schemaValidation.js`, after the existing `MAX_TOTAL_LENGTH` constant and before `validateCharacterData`:

```javascript
const RESERVED_SCHEMA_KEYS = ['id', 'name'];

export function validateSchemaShape(schema) {
  if (!Array.isArray(schema)) return false;
  const seenKeys = new Set();
  for (const field of schema) {
    if (!field || typeof field !== 'object' || typeof field.key !== 'string' || field.key.length === 0) {
      return false;
    }
    if (RESERVED_SCHEMA_KEYS.includes(field.key)) return false;
    if (seenKeys.has(field.key)) return false;
    seenKeys.add(field.key);
  }
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/schemaValidation.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Use the shared function in `backend/events/routes.js`**

Remove the local `isValidCharacterFormSchema` function (lines 7-11) and its call sites' function name, replacing with an import:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { createEvent, getEvent, listEvents, updateEvent, activateEvent } from './repository.js';
import { validateSchemaShape } from './schemaValidation.js';

router.post('/events', requireAuth(requireMenu('events')(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { name, eventDate, characterFormSchema } = body;
  if (!name || !eventDate) {
    return { status: 400, body: { error: 'name and eventDate are required' } };
  }
  if (characterFormSchema !== undefined && !validateSchemaShape(characterFormSchema)) {
    return { status: 400, body: { error: 'characterFormSchema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
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

router.put('/events/:id', requireAuth(requireMenu('events')(async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { characterFormSchema } = body;
  if (characterFormSchema !== undefined && !validateSchemaShape(characterFormSchema)) {
    return { status: 400, body: { error: 'characterFormSchema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
  }
  const event = await updateEvent(params.id, body);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));

router.post('/events/:id/activate', requireAuth(requireMenu('events')(async ({ params }) => {
  const event = await activateEvent(params.id);
  if (!event) return { status: 404, body: { error: 'event not found' } };
  return { status: 200, body: event };
})));
```

- [ ] **Step 6: Use the shared function in `backend/nscSchema/routes.js`**

Remove the local `isValidSchemaShape` function (lines 7-11) and replace its one call site:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { query } from '../db.js';

router.get('/nsc-schema', requireAuth(async ({ user }) => {
  if (user.group.key !== 'admin' && user.group.key !== 'nsc') {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const { rows } = await query('SELECT schema FROM nsc_profile_schema LIMIT 1');
  return { status: 200, body: rows[0]?.schema ?? [] };
}));

router.put('/nsc-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
  }
  const { rows } = await query('SELECT id FROM nsc_profile_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO nsc_profile_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE nsc_profile_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return { status: 200, body: schema };
})));
```

(This step keeps the GET handler's `user.group.key !== 'nsc'` check as-is for now — Task 3 changes it to the new `characterClasses`-based check, since that column doesn't exist until Task 2.)

- [ ] **Step 7: Add integration tests for the new rejection cases**

Add to `tests/integration/events.test.js` (append, using the file's existing `makeUserAndSession` helper):

```javascript
test('PUT /events/:id rejects a characterFormSchema using the reserved key "id" or "name"', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const createRes = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ name: 'Schema Test Con', eventDate: '2027-08-01' }),
  });
  const { id } = await createRes.json();

  const withId = await fetch(`http://localhost:${port}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ characterFormSchema: [{ key: 'id', label: 'Id', type: 'text' }] }),
  });
  assert.equal(withId.status, 400);

  const withDuplicate = await fetch(`http://localhost:${port}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ characterFormSchema: [
      { key: 'klasse', label: 'Klasse', type: 'text' },
      { key: 'klasse', label: 'Klasse (2)', type: 'text' },
    ] }),
  });
  assert.equal(withDuplicate.status, 400);

  server.close();
});
```

Add to `tests/integration/nscSchema.test.js` (append, before the `test.after` block):

```javascript
test('PUT /nsc-schema rejects a schema using the reserved key "id" or duplicate keys', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');

    const withName = await fetch(`http://localhost:${port}/nsc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [{ key: 'name', label: 'Name', type: 'text' }] }),
    });
    assert.equal(withName.status, 400);

    const withDuplicate = await fetch(`http://localhost:${port}/nsc-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [
        { key: 'x', label: 'X', type: 'text' },
        { key: 'x', label: 'X (2)', type: 'text' },
      ] }),
    });
    assert.equal(withDuplicate.status, 400);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 8: Run the tests**

Run: `node --test tests/unit/schemaValidation.test.js tests/integration/events.test.js tests/integration/nscSchema.test.js`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/events/schemaValidation.js backend/events/routes.js backend/nscSchema/routes.js tests/unit/schemaValidation.test.js tests/integration/events.test.js tests/integration/nscSchema.test.js
git commit -m "feat: reject reserved and duplicate field keys in character/NSC schema definitions"
```

---

### Task 2: `groups.character_classes` — Datenmodell + Gruppen-Verwaltung

**Files:**
- Create: `db/migrations/010_group_character_classes.sql`
- Modify: `db/groupDefaults.js`
- Modify: `backend/groups/repository.js`
- Modify: `backend/groups/routes.js`
- Modify: `backend/middleware/authenticate.js`
- Modify: `backend/accounts/repository.js`
- Modify: `frontend/admin/groups.html`
- Modify: `tests/integration/groups.test.js`
- Modify: `tests/integration/schema-users.test.js`
- Modify: `tests/integration/accounts.test.js`

**Interfaces:**
- Produces: `user.group.characterClasses` (array of `'sc'`/`'nsc'`) on the `user` object every `requireAuth`-wrapped handler receives — consumed by Task 3's `POST /characters` permission check and the `GET /nsc-schema` gate. Also produces top-level `characterClasses` on the `GET /account` response body — consumed by Task 5's frontend.

- [ ] **Step 1: Write the migration**

Create `db/migrations/010_group_character_classes.sql`:

```sql
ALTER TABLE groups ADD COLUMN character_classes jsonb NOT NULL DEFAULT '[]';

UPDATE groups SET character_classes = '["nsc"]'::jsonb
WHERE key = 'nsc' AND NOT (character_classes @> '["nsc"]'::jsonb);

UPDATE groups SET character_classes = '["sc"]'::jsonb
WHERE key != 'nsc' AND NOT (character_classes @> '["sc"]'::jsonb);
```

(Same "retroactive grant" pattern as `009_pronomen_field.sql` — a `db/groupDefaults.js` edit alone only affects a brand-new database's first seed run, `db/seedGroups.js` uses `ON CONFLICT (key) DO NOTHING`. Every group except `nsc` gets `'sc'` by default, including Admin/Orga/Plot-Orga/SL/Hilfs-SL — today ANY authenticated user can create SC characters, and this migration must not silently take that away. Only `nsc`-class access is a genuinely new restriction.)

- [ ] **Step 2: Update `db/groupDefaults.js`**

Add `characterClasses` to every one of the 8 entries (so a brand-new database's first seed matches the migration's outcome):

```javascript
export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen', 'group'],
    canEditCharacters: true, characterClasses: ['sc'], isProtected: true,
  },
  {
    key: 'orga', name: 'Orga',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen'],
    canEditCharacters: true, characterClasses: ['sc'], isProtected: false,
  },
  {
    key: 'plot_orga', name: 'Plot-Orga',
    visibleMenus: ['konto', 'charaktere', 'events', 'checkin'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], isProtected: false,
  },
  {
    key: 'sl', name: 'SL',
    visibleMenus: ['konto', 'charaktere', 'checkin'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], isProtected: false,
  },
  {
    key: 'hilfs_sl', name: 'Hilfs-SL',
    visibleMenus: ['konto', 'charaktere', 'checkin'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], isProtected: false,
  },
  {
    key: 'nsc', name: 'NSC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, characterClasses: ['nsc'], isProtected: false,
  },
  {
    key: 'gsc', name: 'GSC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], isProtected: false,
  },
  {
    key: 'sc', name: 'SC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], isProtected: false,
  },
];
```

- [ ] **Step 3: Extend `backend/groups/repository.js`**

Replace the entire file:

```javascript
import { query } from '../db.js';

const SELECT_COLUMNS = 'id, key, name, visible_menus, account_fields, can_edit_characters, character_classes, is_protected';

export async function listGroups() {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups ORDER BY name`);
  return rows;
}

export async function getGroup(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createGroup({ key, name, visibleMenus, accountFields, canEditCharacters, characterClasses }) {
  const { rows } = await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, character_classes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [key, name, JSON.stringify(visibleMenus ?? []), JSON.stringify(accountFields ?? []), !!canEditCharacters, JSON.stringify(characterClasses ?? [])]
  );
  return rows[0];
}

export async function updateGroup(id, { name, visibleMenus, accountFields, canEditCharacters, characterClasses }) {
  const { rows } = await query(
    `UPDATE groups SET
       name = COALESCE($2, name),
       visible_menus = COALESCE($3, visible_menus),
       account_fields = COALESCE($4, account_fields),
       can_edit_characters = COALESCE($5, can_edit_characters),
       character_classes = COALESCE($6, character_classes)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      name ?? null,
      visibleMenus !== undefined ? JSON.stringify(visibleMenus) : null,
      accountFields !== undefined ? JSON.stringify(accountFields) : null,
      canEditCharacters !== undefined ? canEditCharacters : null,
      characterClasses !== undefined ? JSON.stringify(characterClasses) : null,
    ]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Extend `backend/groups/routes.js`**

Replace the entire file:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listGroups, getGroup, createGroup, updateGroup } from './repository.js';
import { ACCOUNT_FIELD_KEYS } from '../accountFields.js';

const MENU_KEYS = ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'];
const CHARACTER_CLASS_KEYS = ['sc', 'nsc'];
const KEY_PATTERN = /^[a-z0-9_]+$/;

function isValidMenuList(value) {
  return Array.isArray(value) && value.every((v) => MENU_KEYS.includes(v));
}

function isValidFieldList(value) {
  return Array.isArray(value) && value.every((v) => ACCOUNT_FIELD_KEYS.includes(v));
}

function isValidCharacterClassList(value) {
  return Array.isArray(value) && value.every((v) => CHARACTER_CLASS_KEYS.includes(v));
}

router.get('/groups', requireAuth(requireAdminGroup(async () => {
  const groups = await listGroups();
  return { status: 200, body: groups };
})));

router.post('/groups', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { key, name, visibleMenus, accountFields, canEditCharacters, characterClasses } = body;
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
  if (characterClasses !== undefined && !isValidCharacterClassList(characterClasses)) {
    return { status: 400, body: { error: `characterClasses must be an array containing only: ${CHARACTER_CLASS_KEYS.join(', ')}` } };
  }
  try {
    const group = await createGroup({ key, name, visibleMenus, accountFields, canEditCharacters, characterClasses });
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
  const { visibleMenus, accountFields, canEditCharacters, characterClasses } = body;
  if (visibleMenus !== undefined && !isValidMenuList(visibleMenus)) {
    return { status: 400, body: { error: `visibleMenus must be an array containing only: ${MENU_KEYS.join(', ')}` } };
  }
  if (accountFields !== undefined && !isValidFieldList(accountFields)) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${ACCOUNT_FIELD_KEYS.join(', ')}` } };
  }
  if (characterClasses !== undefined && !isValidCharacterClassList(characterClasses)) {
    return { status: 400, body: { error: `characterClasses must be an array containing only: ${CHARACTER_CLASS_KEYS.join(', ')}` } };
  }
  const group = await updateGroup(params.id, { name: undefined, visibleMenus, accountFields, canEditCharacters, characterClasses });
  return { status: 200, body: group };
})));
```

(`name` stays out of the destructured update body — matches the existing behavior exactly, `PUT /groups/:id` never updated `name` before this change either; keep it that way, don't expand scope.)

- [ ] **Step 5: Add `characterClasses` to the auth context**

In `backend/middleware/authenticate.js`, add `groups.character_classes` to the SELECT and `characterClasses` to the returned `user.group` object:

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
              groups.visible_menus, groups.account_fields, groups.can_edit_characters, groups.character_classes
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
        characterClasses: row.character_classes,
      },
    };

    return handler({ ...ctx, user });
  };
}
```

- [ ] **Step 6: Add `characterClasses` to `GET /account`'s response**

In `backend/accounts/repository.js`, add `groups.character_classes` to `SELECT_COLUMNS` and `characterClasses: row.character_classes` to `decryptAccount`'s return object (keep every other line — including `nsc_data`/`nscData`, still present at this point in the plan, Task 4 removes it):

```javascript
function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    group: { key: row.group_key, name: row.group_name },
    menus: row.visible_menus,
    canEditCharacters: row.can_edit_characters,
    accountFields: row.account_fields,
    characterClasses: row.character_classes,
    emailVerified: row.email_verified,
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
    pronomen: decryptField(row.pronomen_enc),
    nscData: row.nsc_data,
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc, users.pronomen_enc, users.nsc_data,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields, groups.character_classes
`;
```

(Only `decryptAccount` and `SELECT_COLUMNS` change here — `getAccount`/`updateAccount` are untouched by this step.)

- [ ] **Step 7: Add character-class checkboxes to `frontend/admin/groups.html`**

Add a new checkbox group after the existing `#field-checkboxes` block (before the `can-edit-characters` checkbox block):

```html
        <h3>Darf Charakter-Klassen anlegen</h3>
        <div class="checkbox-group" id="class-checkboxes">
          <label><input type="checkbox" value="sc"> SC (inkl. GSC)</label>
          <label><input type="checkbox" value="nsc"> NSC</label>
        </div>
```

In the script, add `characterClasses: getCheckedValues('class-checkboxes')` to the submit handler's `payload` object, and `setCheckedValues('class-checkboxes', group.character_classes)` to `startEdit`:

```javascript
function startEdit(group) {
  editingGroupId = group.id;
  formTitle.textContent = `Gruppe bearbeiten: ${group.name}`;
  nameInput.value = group.name;
  keyInput.value = group.key;
  keyInput.disabled = true;
  setCheckedValues('menu-checkboxes', group.visible_menus);
  setCheckedValues('field-checkboxes', group.account_fields);
  setCheckedValues('class-checkboxes', group.character_classes);
  document.getElementById('can-edit-characters').checked = group.can_edit_characters;
  form.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
  cancelButton.style.display = '';
}
```

```javascript
  const payload = {
    name: nameInput.value,
    visibleMenus: getCheckedValues('menu-checkboxes'),
    accountFields: getCheckedValues('field-checkboxes'),
    characterClasses: getCheckedValues('class-checkboxes'),
    canEditCharacters: document.getElementById('can-edit-characters').checked,
  };
```

- [ ] **Step 8: Write the failing integration tests**

Add to `tests/integration/groups.test.js` (read the current file first to match its exact `makeUserAndSession`/cleanup conventions, then append a test following that pattern):

```javascript
test('POST /groups accepts and returns characterClasses; PUT /groups/:id updates them', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ key: `test_class_${crypto.randomUUID().slice(0, 8)}`, name: 'Class Test', characterClasses: ['sc'] }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.deepEqual(created.character_classes, ['sc']);

    const updateRes = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ characterClasses: ['sc', 'nsc'] }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.deepEqual(updated.character_classes, ['sc', 'nsc']);

    await query('DELETE FROM groups WHERE id = $1', [created.id]);
  } finally {
    server.close();
  }
});

test('POST /groups rejects an invalid characterClasses value', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const admin = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ key: `test_bad_class_${crypto.randomUUID().slice(0, 8)}`, name: 'Bad Class Test', characterClasses: ['wizard'] }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
```

Add to `tests/integration/schema-users.test.js` (append):

```javascript
test('every group except nsc has "sc" in character_classes; nsc has "nsc" after migration', async () => {
  const { rows } = await query('SELECT key, character_classes FROM groups');
  for (const row of rows) {
    if (row.key === 'nsc') {
      assert.ok(row.character_classes.includes('nsc'), 'nsc group should include nsc');
    } else {
      assert.ok(row.character_classes.includes('sc'), `${row.key} should include sc`);
    }
  }
});
```

Add to `tests/integration/accounts.test.js` (find the existing `'GET /account returns...'`-style test and add an assertion, or add a new small test):

```javascript
test('GET /account includes characterClasses from the caller\'s group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await registerLoginAndGetCookie(port);
    const res = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    const body = await res.json();
    assert.deepEqual(body.characterClasses, ['sc']);
  } finally {
    server.close();
  }
});
```

(Read `tests/integration/accounts.test.js`'s actual current content first — this uses the file's existing `registerLoginAndGetCookie(port)` helper; adapt to whatever the file's real structure is.)

- [ ] **Step 9: Run the tests**

Run: `node --test tests/integration/groups.test.js tests/integration/schema-users.test.js tests/integration/accounts.test.js`
Expected: all PASS (existing + new).

- [ ] **Step 10: Verify visually**

Using Claude Browser tools against the running dev stack: log in as `admin@pakyrion.local`/`0000`, go to `/admin/groups.html`, confirm the "Darf Charakter-Klassen anlegen" checkboxes appear in both the create form and when editing a non-protected group (e.g. `orga` — confirm its row already shows "SC" checked, proving the data migration applied), toggle and save, reload, confirm it persisted.

- [ ] **Step 11: Commit**

```bash
git add db/migrations/010_group_character_classes.sql db/groupDefaults.js backend/groups/repository.js backend/groups/routes.js backend/middleware/authenticate.js backend/accounts/repository.js frontend/admin/groups.html tests/integration/groups.test.js tests/integration/schema-users.test.js tests/integration/accounts.test.js
git commit -m "feat: add groups.character_classes as a per-group, data-driven permission"
```

---

### Task 3: `characters.class` + NSC-Charaktere über die Charakter-API

**Files:**
- Create: `db/migrations/011_character_class_and_nullable_event.sql`
- Create: `backend/nscSchema/repository.js`
- Modify: `backend/nscSchema/routes.js`
- Modify: `backend/characters/repository.js`
- Modify: `backend/characters/routes.js`
- Modify: `tests/integration/characters.test.js`
- Modify: `tests/integration/nscSchema.test.js`

**Interfaces:**
- Consumes: `user.group.characterClasses` (Task 2) for the new `POST /characters` permission check and the `GET /nsc-schema` gate.
- Produces: `export async function getNscProfileSchema()` and `export async function setNscProfileSchema(schema)` from `backend/nscSchema/repository.js` — consumed by `backend/characters/repository.js` (validating NSC-class character data) and by `backend/nscSchema/routes.js` itself.
- Produces: `createCharacter(userId, { characterClass, eventId, name, data })` (renamed parameter — was `{ eventId, name, data }`) from `backend/characters/repository.js`. `GET`/`POST`/`PUT /characters*` responses now include a `class` field on every character.

- [ ] **Step 1: Write the migration**

Create `db/migrations/011_character_class_and_nullable_event.sql`:

```sql
ALTER TABLE characters ADD COLUMN class text NOT NULL DEFAULT 'sc' CHECK (class IN ('sc', 'nsc'));
ALTER TABLE characters ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE characters ADD CONSTRAINT characters_class_event_check
  CHECK ((class = 'sc' AND event_id IS NOT NULL) OR (class = 'nsc' AND event_id IS NULL));
```

- [ ] **Step 2: Extract `backend/nscSchema/repository.js`**

Create the file:

```javascript
import { query } from '../db.js';

export async function getNscProfileSchema() {
  const { rows } = await query('SELECT schema FROM nsc_profile_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setNscProfileSchema(schema) {
  const { rows } = await query('SELECT id FROM nsc_profile_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO nsc_profile_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE nsc_profile_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}
```

- [ ] **Step 3: Rewrite `backend/nscSchema/routes.js` to use the repository and the new permission check**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getNscProfileSchema, setNscProfileSchema } from './repository.js';

router.get('/nsc-schema', requireAuth(async ({ user }) => {
  if (user.group.key !== 'admin' && !user.group.characterClasses.includes('nsc')) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const schema = await getNscProfileSchema();
  return { status: 200, body: schema };
}));

router.put('/nsc-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "name")' } };
  }
  const saved = await setNscProfileSchema(schema);
  return { status: 200, body: saved };
})));
```

(The GET gate changes from `user.group.key !== 'nsc'` to `!user.group.characterClasses.includes('nsc')` — any group an admin has granted `'nsc'` character-class access to can now read the schema, not just the literal `nsc` group.)

- [ ] **Step 4: Rewrite `backend/characters/repository.js`**

```javascript
import { query } from '../db.js';
import { validateCharacterData } from '../events/schemaValidation.js';
import { getEvent } from '../events/repository.js';
import { getNscProfileSchema } from '../nscSchema/repository.js';

const SELECT_COLUMNS = 'id, user_id, event_id, class, name, data, created_at';

export async function createCharacter(userId, { characterClass, eventId, name, data }) {
  if (characterClass === 'nsc') {
    const schema = await getNscProfileSchema();
    const errors = validateCharacterData(schema, data ?? {});
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
    const { rows } = await query(
      `INSERT INTO characters (user_id, event_id, class, name, data)
       VALUES ($1, NULL, 'nsc', $2, $3)
       RETURNING ${SELECT_COLUMNS}`,
      [userId, name, JSON.stringify(data ?? {})]
    );
    return rows[0];
  }

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
    `INSERT INTO characters (user_id, event_id, class, name, data)
     VALUES ($1, $2, 'sc', $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [userId, eventId, name, JSON.stringify(data ?? {})]
  );
  return rows[0];
}

export async function getCharacter(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM characters WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listCharactersForUser(userId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM characters WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  return rows;
}

export async function updateCharacter(id, userId, { name, data }) {
  const character = await getCharacter(id);
  if (!character || character.user_id !== userId) return null;

  if (data !== undefined) {
    let schema;
    if (character.class === 'nsc') {
      schema = await getNscProfileSchema();
    } else {
      const event = await getEvent(character.event_id);
      if (!event) {
        const err = new Error('event not found');
        err.code = 'EVENT_NOT_FOUND';
        throw err;
      }
      schema = event.character_form_schema;
    }
    const errors = validateCharacterData(schema, data);
    if (errors.length > 0) {
      const err = new Error('invalid character data');
      err.code = 'INVALID_CHARACTER_DATA';
      err.details = errors;
      throw err;
    }
  }

  const { rows } = await query(
    `UPDATE characters SET
       name = COALESCE($3, name),
       data = COALESCE($4, data)
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [id, userId, name ?? null, data !== undefined ? JSON.stringify(data) : null]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 5: Rewrite `backend/characters/routes.js`**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getEvent } from '../events/repository.js';
import { createCharacter, getCharacter, listCharactersForUser, updateCharacter } from './repository.js';

router.post('/characters', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { class: characterClass = 'sc', eventId, name, data } = body;
  if (characterClass !== 'sc' && characterClass !== 'nsc') {
    return { status: 400, body: { error: 'class must be "sc" or "nsc"' } };
  }
  if (!name) {
    return { status: 400, body: { error: 'name is required' } };
  }
  if (!user.group.characterClasses.includes(characterClass)) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  if (characterClass === 'sc') {
    if (!eventId) return { status: 400, body: { error: 'eventId is required' } };
    if (!user.group.canEditCharacters) {
      const event = await getEvent(eventId);
      if (!event) return { status: 404, body: { error: 'event not found' } };
      if (!event.is_active) {
        return { status: 403, body: { error: 'characters can only be created for the currently active event' } };
      }
    }
  } else if (eventId) {
    return { status: 400, body: { error: 'eventId must not be set for nsc-class characters' } };
  }

  try {
    const character = await createCharacter(user.id, { characterClass, eventId, name, data });
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
  if (character.user_id !== user.id && !user.group.canEditCharacters) {
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
    const updated = await updateCharacter(params.id, user.id, body);
    return { status: 200, body: updated };
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') return { status: 404, body: { error: 'event not found' } };
    if (err.code === 'INVALID_CHARACTER_DATA') {
      return { status: 400, body: { error: 'invalid character data', details: err.details } };
    }
    throw err;
  }
}));
```

(`class` defaults to `'sc'` when omitted from the request body — every existing caller that doesn't send `class` keeps working exactly as before, since every group defaults to `characterClasses: ['sc']` or better per Task 2.)

- [ ] **Step 6: Write the failing tests for NSC-class characters**

Add to `tests/integration/characters.test.js` (append, before `test.after`):

```javascript
test('creating an nsc-class character validates against the current nsc_profile_schema, not an event', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const nscUser = await makeUserAndSession('nsc');

  const missingRequired = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
    body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: { rollenAusruestung: ['NichtErlaubt'] } }),
  });
  assert.equal(missingRequired.status, 400);

  const ok = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
    body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: {} }),
  });
  assert.equal(ok.status, 201);
  const created = await ok.json();
  assert.equal(created.class, 'nsc');
  assert.equal(created.event_id, null);

  server.close();
});

test('an nsc-class character request with an eventId is rejected', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const nscUser = await makeUserAndSession('nsc');
  const eventId = await makeEvent([]);

  const res = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
    body: JSON.stringify({ class: 'nsc', eventId, name: 'Invalid', data: {} }),
  });
  assert.equal(res.status, 400);

  server.close();
});

test('a group without nsc character-class access cannot create an nsc-class character', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const scUser = await makeUserAndSession('sc');

  const res = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: scUser.cookie },
    body: JSON.stringify({ class: 'nsc', name: 'Not Allowed', data: {} }),
  });
  assert.equal(res.status, 403);

  server.close();
});

test('a user can create multiple sc-class characters for the same event (Ersatzcharaktere)', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const participant = await makeUserAndSession();
  const eventId = await makeEvent([]);

  const first = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify({ eventId, name: 'Hauptcharakter', data: {} }),
  });
  assert.equal(first.status, 201);

  const second = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify({ eventId, name: 'Ersatzcharakter', data: {} }),
  });
  assert.equal(second.status, 201);

  const list = await (await fetch(`http://localhost:${port}/characters`, { headers: { Cookie: participant.cookie } })).json();
  assert.equal(list.filter((c) => c.event_id === eventId).length, 2);

  server.close();
});

test('PUT on an nsc-class character validates against the current nsc_profile_schema', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const nscUser = await makeUserAndSession('nsc');

  const createRes = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
    body: JSON.stringify({ class: 'nsc', name: 'Wache Eins', data: {} }),
  });
  const { id } = await createRes.json();

  const invalidPut = await fetch(`http://localhost:${port}/characters/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
    body: JSON.stringify({ data: { rollenAusruestung: ['NichtErlaubt'] } }),
  });
  assert.equal(invalidPut.status, 400);

  const validPut = await fetch(`http://localhost:${port}/characters/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
    body: JSON.stringify({ name: 'Wache Zwei' }),
  });
  assert.equal(validPut.status, 200);
  assert.equal((await validPut.json()).name, 'Wache Zwei');

  server.close();
});
```

- [ ] **Step 7: Update `tests/integration/nscSchema.test.js`'s setup**

The `GET /nsc-schema is reachable by an nsc-group user...` test already uses `makeUserAndSession('nsc')`, which now needs the `nsc` group to have `character_classes` including `'nsc'` — this is already true from Task 2's migration/seed defaults, so no change needed to this specific test. But this file's tests need `seedNscProfileSchema()` to have run before `characters.test.js`'s new NSC tests can validate real data — confirm `tests/integration/characters.test.js` also seeds it (see next step).

- [ ] **Step 8: Add NSC schema seeding to `tests/integration/characters.test.js`'s setup**

Near the top of the file, after the existing `seedGroups()` call, add:

```javascript
const { seedNscProfileSchema } = await import('../../db/seedNscProfileSchema.js');
await seedNscProfileSchema();
```

(Needed because this file's new tests create `class: 'nsc'` characters, which validate against the real `nsc_profile_schema` row — without seeding it, the schema would be `[]` and every NSC character's data would trivially pass, missing real coverage. The `rollenAusruestung` field used in the new tests' invalid-data assertions comes from `config/nscProfileDefaults.js`'s seeded defaults.)

- [ ] **Step 9: Run the tests**

Run: `node --test tests/integration/characters.test.js tests/integration/nscSchema.test.js`
Expected: all PASS (existing + new).

- [ ] **Step 10: Commit**

```bash
git add db/migrations/011_character_class_and_nullable_event.sql backend/nscSchema/repository.js backend/nscSchema/routes.js backend/characters/repository.js backend/characters/routes.js tests/integration/characters.test.js tests/integration/nscSchema.test.js
git commit -m "feat: unify SC and NSC characters into one class-discriminated characters table"
```

---

### Task 4: Bestehende NSC-Profile migrieren; `nscData` von `PATCH /account` entfernen

**Files:**
- Create: `db/migrations/012_migrate_nsc_data_to_characters.sql`
- Modify: `backend/accounts/routes.js`
- Modify: `backend/accounts/repository.js`
- Modify: `tests/integration/accounts.test.js`
- Modify: `tests/integration/schema-users.test.js`

**Interfaces:**
- Consumes: `characters` table's `class`/nullable `event_id` (Task 3).
- Produces: `updateAccount(userId, fields)` reverts to its pre-`nscData` 8-parameter signature (`name`, `address`, `birthdate`, `phone`, `emergencyContact`, `medicalNotes`, `pronomen`) — `fields.nscData` is no longer read.

- [ ] **Step 1: Write the migration**

Create `db/migrations/012_migrate_nsc_data_to_characters.sql`:

```sql
INSERT INTO characters (user_id, event_id, class, name, data)
SELECT id, NULL, 'nsc', name, nsc_data
FROM users
WHERE nsc_data IS NOT NULL AND nsc_data::text != '{}';

ALTER TABLE users DROP COLUMN nsc_data;
```

(Migrated characters are named after the user's account name, since no separate NSC-character name field existed before — users can rename them afterward like any other character. On a fresh test/dev database this `INSERT ... SELECT` matches zero rows, since no user has non-empty `nsc_data` yet; the `DROP COLUMN` still runs and is what Step 4's tests actually verify.)

- [ ] **Step 2: Remove `nscData` handling from `backend/accounts/routes.js`**

Replace the entire file:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getAccount, updateAccount } from './repository.js';

router.get('/account', requireAuth(async ({ user }) => {
  const account = await getAccount(user.id);
  return { status: 200, body: account };
}));

router.patch('/account', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const account = await updateAccount(user.id, body);
  if (!account) return { status: 404, body: { error: 'account not found' } };
  return { status: 200, body: account };
}));
```

- [ ] **Step 3: Remove `nscData`/`nsc_data` from `backend/accounts/repository.js`**

Replace the entire file (keeps Task 2's `characterClasses` addition, removes only the `nscData`/`nsc_data` lines Plan 4 added):

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
    accountFields: row.account_fields,
    characterClasses: row.character_classes,
    emailVerified: row.email_verified,
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
    pronomen: decryptField(row.pronomen_enc),
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc, users.pronomen_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields, groups.character_classes
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
       medical_notes_enc = COALESCE($7, medical_notes_enc),
       pronomen_enc = COALESCE($8, pronomen_enc)
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
      fields.pronomen !== undefined ? encryptField(fields.pronomen) : null,
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}
```

- [ ] **Step 4: Remove or adapt the now-obsolete `nscData` tests in `tests/integration/accounts.test.js`**

Read the current file. Delete the two tests added by the earlier NSC-on-account plan ("PATCH /account validates nscData against the current nsc_profile_schema" and "PATCH /account accepts and round-trips valid nscData") along with the "PATCH /account gates nscData to the nsc group" test if present (search for `nscData` in this file — all matches are obsolete now that the endpoint no longer accepts this field). Add one small replacement test confirming the field is silently ignored (not an error) if a client still sends it, matching how `PATCH /account` already ignores unknown fields it wasn't asked to update:

```javascript
test('PATCH /account silently ignores an nscData field (no longer a recognized account field)', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await registerLoginAndGetCookie(port);
    const res = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Still Works', nscData: { anything: 'ignored' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Still Works');
    assert.equal(body.nscData, undefined);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 5: Add a migration-outcome test to `tests/integration/schema-users.test.js`**

```javascript
test('users.nsc_data column no longer exists after migration', async () => {
  const { rows } = await query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'nsc_data'"
  );
  assert.equal(rows.length, 0);
});
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/integration/accounts.test.js tests/integration/schema-users.test.js`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/012_migrate_nsc_data_to_characters.sql backend/accounts/routes.js backend/accounts/repository.js tests/integration/accounts.test.js tests/integration/schema-users.test.js
git commit -m "feat: migrate NSC profile data into the characters table, remove nscData from PATCH /account"
```

---

### Task 5: Frontend — NSC-Charaktere auf `characters.html`, Abschnitt auf `account.html` entfernen; volle Testsuite

**Files:**
- Modify: `frontend/characters.html`
- Modify: `frontend/account.html`
- Modify: `tests/unit/formFields.test.js` (only if Step 5's manual check surfaces a gap — see Step 6)

**Interfaces:**
- Consumes: `account.characterClasses` (Task 2), `GET /nsc-schema` (Task 3), `collectFieldValues`/`renderField` (already shared, from an earlier plan).

- [ ] **Step 1: Remove the NSC section from `frontend/account.html`**

Delete the `<div id="nsc-section">...</div>` block (currently lines 36-41) and the entire `if (account.group.key === 'nsc') { ... }` block inside the script (currently lines 71-86, ending at the closing `});` of the submit-handler's `addEventListener`). Read the file first to get exact current line numbers before deleting — other plans may have shifted them slightly.

- [ ] **Step 2: Add the NSC section markup to `frontend/characters.html`**

Add after the existing `<p id="message"></p>` line (currently line 42), before the closing `</div>` of `.folio`:

```html
    <div id="nsc-section" style="display:none;">
      <h2>Meine NSC-Charaktere</h2>
      <div id="nsc-character-list" class="char-grid"></div>

      <h3 id="nsc-form-title">Neuen NSC-Charakter anlegen</h3>
      <form id="nsc-character-form">
        <label for="nsc-character-name">Charaktername</label>
        <input id="nsc-character-name" name="name" type="text" required>
        <div id="nsc-dynamic-fields"></div>
        <button type="submit">Speichern</button>
        <button type="button" id="nsc-cancel-edit" style="display:none;" class="btn-ghost">Abbrechen</button>
      </form>
      <p id="nsc-message"></p>
    </div>
```

- [ ] **Step 3: Add the NSC state, rendering, and submit logic to `frontend/characters.html`'s script**

Add new module-level state and DOM references, right after the existing `const copyFromSelect = document.getElementById('copy-from-select');` line:

```javascript
let nscSchema = [];
let nscCharacters = [];
let editingNscCharacterId = null;

const nscSection = document.getElementById('nsc-section');
const nscListBody = document.getElementById('nsc-character-list');
const nscForm = document.getElementById('nsc-character-form');
const nscMessage = document.getElementById('nsc-message');
const nscFormTitle = document.getElementById('nsc-form-title');
const nscDynamicFields = document.getElementById('nsc-dynamic-fields');
const nscCancelButton = document.getElementById('nsc-cancel-edit');
```

Add these functions after the existing `tagsForCharacter` function:

```javascript
function renderNscSchemaFields(data = {}) {
  nscDynamicFields.innerHTML = nscSchema.map((field) => renderField(field, data[field.key])).join('');
}

function tagsForNscCharacter(c) {
  return nscSchema
    .map((field) => ({ field, value: tagValueForField(field, c.data[field.key]) }))
    .filter(({ value }) => value !== undefined)
    .map(({ field, value }) => `<span class="tag">${escapeHtml(field.label)}: ${escapeHtml(value)}</span>`)
    .join('');
}

function renderNscList() {
  nscListBody.innerHTML = nscCharacters.map((c) => `<div class="char-card">
      <h3>${escapeHtml(c.name)}</h3>
      <div class="char-tags">${tagsForNscCharacter(c)}</div>
      <button type="button" data-nsc-edit="${c.id}" class="btn-ghost" style="margin-top:14px;">Bearbeiten</button>
    </div>`).join('');

  nscListBody.querySelectorAll('[data-nsc-edit]').forEach((button) => {
    button.addEventListener('click', () => startNscEdit(button.dataset.nscEdit));
  });
}

function startNscEdit(characterId) {
  const character = nscCharacters.find((c) => c.id === characterId);
  if (!character) return;
  editingNscCharacterId = characterId;
  nscFormTitle.textContent = `NSC-Charakter bearbeiten: ${character.name}`;
  nscForm.elements.name.value = character.name;
  renderNscSchemaFields(character.data);
  nscForm.querySelector('button[type="submit"]').textContent = 'Änderungen speichern';
  nscCancelButton.style.display = '';
}

function resetNscForm() {
  editingNscCharacterId = null;
  nscFormTitle.textContent = 'Neuen NSC-Charakter anlegen';
  nscForm.reset();
  renderNscSchemaFields();
  nscForm.querySelector('button[type="submit"]').textContent = 'Speichern';
  nscCancelButton.style.display = 'none';
}

nscCancelButton.addEventListener('click', resetNscForm);

nscForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  nscMessage.textContent = '';
  nscMessage.className = '';
  const name = nscForm.elements.name.value;
  const data = collectFieldValues(nscForm, nscSchema);
  try {
    if (editingNscCharacterId) {
      await api.put(`/characters/${editingNscCharacterId}`, { name, data });
    } else {
      await api.post('/characters', { class: 'nsc', name, data });
    }
    nscMessage.textContent = 'Gespeichert.';
    nscMessage.className = 'success';
    resetNscForm();
    await loadCharacters();
  } catch (err) {
    nscMessage.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    nscMessage.className = 'error';
  }
});
```

- [ ] **Step 4: Wire the SC list to filter by class and load NSC characters**

Replace `loadCharacters()` and `populateCopyFromOptions()`:

```javascript
function populateCopyFromOptions() {
  const scCharacters = characters.filter((c) => c.class !== 'nsc');
  copyFromSelect.innerHTML = '<option value="">– keinen übernehmen –</option>' + scCharacters.map((c) => {
    const event = events.find((e) => e.id === c.event_id);
    return `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(event ? event.name : c.event_id)})</option>`;
  }).join('');
}
```

```javascript
async function loadCharacters() {
  characters = await api.get('/characters');
  const scCharacters = characters.filter((c) => c.class !== 'nsc');
  listBody.innerHTML = scCharacters.map((c) => {
    const event = events.find((e) => e.id === c.event_id);
    const tagsHtml = tagsForCharacter(c);
    return `<div class="char-card">
      <h3>${escapeHtml(c.name)}</h3>
      <div class="char-meta">${escapeHtml(event ? event.name : c.event_id)}</div>
      <div class="char-tags">${tagsHtml}</div>
      <button type="button" data-edit="${c.id}" class="btn-ghost" style="margin-top:14px;">Bearbeiten</button>
    </div>`;
  }).join('');

  listBody.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => startEdit(button.dataset.edit));
  });

  populateCopyFromOptions();

  if (nscSection.style.display !== 'none') {
    nscCharacters = characters.filter((c) => c.class === 'nsc');
    renderNscList();
  }
}
```

- [ ] **Step 5: Add `class: 'sc'` to the SC submit handler, and load the NSC section on page init**

In the existing `form.addEventListener('submit', ...)` handler, change the create call:

```javascript
      await api.post('/characters', { class: 'sc', eventId, name, data: rest });
```

At the bottom of the script, change the final `try` block:

```javascript
try {
  const account = await api.get('/account');
  canEditCharacters = account.canEditCharacters;
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  if (account.characterClasses?.includes('nsc')) {
    nscSchema = await api.get('/nsc-schema');
    nscSection.style.display = '';
  }
  await loadEvents();
  await loadCharacters();
  await loadRegistrations();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
```

- [ ] **Step 6: Verify visually**

Using Claude Browser tools against the running dev stack:
1. Log in as `admin@pakyrion.local`/`0000`, go to `/account.html`, confirm the NSC section is gone entirely.
2. Create a throwaway `nsc`-group user (invite flow or direct SQL + a set password), log in as them, go to `/characters.html`, confirm the "Meine NSC-Charaktere" section appears with the seeded NSC schema fields (checkboxes for booleans, selects for the scales, a checkbox group for `rollenAusruestung`, textareas). Create an NSC character, confirm it appears in the list with correct tags, edit it, confirm the change persists.
3. Log in as a plain `sc`-group user, confirm the NSC section does NOT appear on `/characters.html`, and confirm creating a second (Ersatz-)character for the same event works and both show up in the list.
4. Clean up all test accounts/characters created during verification afterward.

- [ ] **Step 7: Run the FULL test suite**

Run: `npm test`
Expected: every test in the project passes. This is the mandatory full-suite check per this plan's Global Constraints — do not skip or substitute a scoped subset. If anything fails, fix it before considering this plan done.

- [ ] **Step 8: Final commit if Step 7 required fixes**

If Step 7 was already green with no changes needed, skip this step. Otherwise:

```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

- [ ] **Step 9: Commit**

```bash
git add frontend/characters.html frontend/account.html
git commit -m "feat: add NSC-class character management to characters.html, remove NSC section from account.html"
```

## Self-Review Notes (for the plan author / controller, not a task)

- Spec coverage: covers Abschnitt 1 (Charakter-Klassen, Datenmodell, Migration, API, Frontend, Rückabwicklungs-Hinweis) and Abschnitt 2 (Namenskollisionsschutz) of `2026-08-28-charakterklassen-und-hardening-design.md` in full. Abschnitte 3-5 (Status-Override, Rate-Limiting, technische Schulden) are separate plans per the spec's own recommended decomposition.
- A real default-permission bug was caught and fixed in the spec itself before this plan was written: `characterClasses: []` for non-`nsc` groups would have broken existing, currently-passing tests (e.g. an admin creating a character for an inactive event) by silently revoking a capability every group has always had. Corrected to `['sc']` for every group except `nsc`.
- Type/shape consistency: `createCharacter`'s parameter renamed from `{ eventId, name, data }` to `{ characterClass, eventId, name, data }` consistently across Task 3's repository and routes changes. `user.group.characterClasses` (Task 2) is consumed identically by Task 3's `POST /characters` permission check and `GET /nsc-schema` gate. `account.characterClasses` (top-level, Task 2) is consumed identically by Task 5's frontend gate — deliberately NOT nested under `account.group`, matching the existing `menus`/`canEditCharacters`/`accountFields` top-level pattern in `decryptAccount`.
- Migration ordering: 010 (groups) → 011 (characters.class + nullable event_id) → 012 (data migration + drop nsc_data) — each depends on the previous being applied, matches task ordering 2 → 3 → 4.
