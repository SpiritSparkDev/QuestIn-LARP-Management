# OT-Felder admin-definierbar machen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin define OT (account/registration) fields the same way IT (character) fields already work for SC/NSC — a JSONB schema editable via an admin UI, instead of a fixed set of hardcoded encrypted Postgres columns.

**Architecture:** Two new singleton-row schema tables (`account_field_schema`, `registration_field_schema`), same shape and pattern as the existing `sc_character_schema`/`nsc_profile_schema`. The 13 existing per-field encrypted columns on `users`/`invitations`/`registrations` are replaced by one AES-256-GCM-encrypted JSON blob column per table, decrypted/merged/re-encrypted generically instead of read/written column-by-column. `groups.account_fields` stays a single permission allowlist, validated against the union of both schemas' live keys instead of a hardcoded key list.

**Tech Stack:** Node.js (`node:test`), Postgres (`pg`), vanilla JS frontend, no framework — matches the existing codebase exactly.

**Spec:** `docs/superpowers/specs/2026-09-17-ot-felder-admin-schema-design.md`

## Global Constraints

- `group` stays a hardcoded, unencrypted, non-schema permission field — never part of either new schema (reserved key).
- `firstName`/`lastName`/`nickname`/email/password stay fixed structural columns, not schema fields.
- No `public` flag on OT schema fields — visibility stays governed entirely by `groups.account_fields`.
- No value-level validation added to `PATCH /account`, `PATCH /members/:id`, or `PUT .../ot-fields` — only the schema *definition* is validated (via `validateSchemaShape`) when an admin edits it. This matches today's actual behavior (zero value validation on OT writes) and must not regress the existing test asserting an unknown key like `nscData` is silently ignored, not rejected.
- Deleted/renamed schema fields leave orphaned values in the encrypted blob — never actively cleaned up. Matches existing character-schema behavior.
- `frontend/js/formFields.js`'s `renderAccountFieldInput` must keep wrapping every field in `<div class="${key}-container">` — this is an intentional, CLAUDE.md-protected UI hook. Never collapse it back to a bare label+input.
- Every plan task that touches a DB column must grep the whole repo (`backend/`, `frontend/`, `tests/`) for the old column/constant names before considering the task done — this project has repeatedly had stale references slip through per-task review in past plans.
- The last task must run the full `npm test` suite, not just a scoped subset.
- Never pass `isolation: worktree` when dispatching a task implementer — this plan runs in one shared worktree for its whole lifetime.

---

## Task 1: Add a `date` field type to the shared schema plumbing

**Files:**
- Modify: `backend/events/schemaValidation.js`
- Modify: `frontend/js/formFields.js`
- Modify: `frontend/admin/character-schema.html`
- Test: `tests/unit/schemaValidation.test.js`
- Test: `tests/unit/formFields.test.js`

**Interfaces:**
- Produces: `validateCharacterData` accepts `type: 'date'` fields (string values only). `renderField` renders `<input type="date">` for `type: 'date'`. `collectFieldValues` needs no change — its default (non-boolean/multiselect/number) branch already reads a date input's value as a plain string via `FormData`.

- [ ] **Step 1: Write the failing unit tests**

Add to `tests/unit/schemaValidation.test.js` (after the existing link-type tests, before the `validateSchemaShape` tests):

```javascript
const DATE_SCHEMA = [
  { key: 'geburtstag', label: 'Geburtstag', type: 'date', required: false },
];

test('a date value given as a string is valid', () => {
  assert.deepEqual(validateCharacterData(DATE_SCHEMA, { geburtstag: '2000-01-01' }), []);
});

test('a non-string value for a date field is an error', () => {
  const errors = validateCharacterData(DATE_SCHEMA, { geburtstag: 123 });
  assert.ok(errors.some((e) => e.includes('geburtstag')));
});
```

Add to `tests/unit/formFields.test.js` (after the `renderField renders a URL input for type "link"` test):

```javascript
test('renderField renders an input type="date" for type "date"', () => {
  const html = renderField({ key: 'geburtstag', label: 'Geburtstag', type: 'date' }, '2000-01-01');
  assert.ok(html.includes('type="date"'));
  assert.ok(html.includes('value="2000-01-01"'));
  assert.ok(html.includes('name="geburtstag"'));
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test tests/unit/schemaValidation.test.js tests/unit/formFields.test.js`
Expected: FAIL — no `date` branch exists yet in either function, so the date-typed value falls through to no validation error, and `renderField` falls through to the generic `type="text"` branch (the `type="date"` assertion fails).

- [ ] **Step 3: Implement the `date` type**

In `backend/events/schemaValidation.js`, add a date check right after the existing link checks (after the `link` validation block, before the max-length check):

```javascript
    if (!isEmpty && field.type === 'date' && typeof value !== 'string') {
      errors.push(`${label} muss ein Datum sein`);
    }
```

In `frontend/js/formFields.js`'s `renderField`, add a branch right after the `link` branch:

```javascript
  if (field.type === 'date') {
    return `<input id="${id}" name="${key}" type="date" value="${val}" ${required}><label for="${id}">${label}</label>`;
  }
```

In `frontend/admin/character-schema.html`'s `addSchemaRow`, add a new option to the type `<select>` (after the `link` option):

```html
      <option value="date" ${field.type === 'date' ? 'selected' : ''}>Datum</option>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/schemaValidation.test.js tests/unit/formFields.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/events/schemaValidation.js frontend/js/formFields.js frontend/admin/character-schema.html tests/unit/schemaValidation.test.js tests/unit/formFields.test.js
git commit -m "feat: add date field type to the shared IT/OT schema plumbing"
```

---

## Task 2: Admin-editable account/registration field schemas (additive, no data migration yet)

**Files:**
- Modify: `backend/events/schemaValidation.js` (parameterize reserved keys)
- Create: `db/migrations/033_account_registration_field_schema.sql`
- Create: `backend/accountFieldSchema/repository.js`
- Create: `backend/accountFieldSchema/routes.js`
- Create: `backend/registrationFieldSchema/repository.js`
- Create: `backend/registrationFieldSchema/routes.js`
- Modify: `backend/server.js`
- Test: `tests/unit/schemaValidation.test.js`
- Test: `tests/integration/accountFieldSchema.test.js` (new)
- Test: `tests/integration/registrationFieldSchema.test.js` (new)

**Interfaces:**
- Produces: `getAccountFieldSchema()`/`setAccountFieldSchema(schema)`, `getRegistrationFieldSchema()`/`setRegistrationFieldSchema(schema)` — same signatures as `getScCharacterSchema`/`setScCharacterSchema`. `GET/PUT /account-schema`, `GET/PUT /registration-schema` endpoints. `validateSchemaShape(schema, reservedKeys?)` — `reservedKeys` defaults to `['id', 'name', 'eventId']` (unchanged default behavior for existing callers).

- [ ] **Step 1: Write the failing test for parameterized reserved keys**

Add to `tests/unit/schemaValidation.test.js` (after the existing reserved-key tests):

```javascript
test('validateSchemaShape accepts a custom reserved-key list, rejecting only those keys', () => {
  assert.equal(validateSchemaShape([{ key: 'group', label: 'Gruppe', type: 'text' }], ['id', 'group']), false);
  assert.equal(validateSchemaShape([{ key: 'address', label: 'Adresse', type: 'text' }], ['id', 'group']), true);
  // Default reserved keys still apply when no second argument is given.
  assert.equal(validateSchemaShape([{ key: 'name', label: 'Name', type: 'text' }]), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/schemaValidation.test.js`
Expected: FAIL — `validateSchemaShape` doesn't accept a second argument yet, so the `['id', 'group']` list is ignored and `group` isn't rejected.

- [ ] **Step 3: Parameterize `validateSchemaShape`**

In `backend/events/schemaValidation.js`, replace:

```javascript
const RESERVED_SCHEMA_KEYS = ['id', 'name', 'eventId'];

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

with:

```javascript
const DEFAULT_RESERVED_SCHEMA_KEYS = ['id', 'name', 'eventId'];

export function validateSchemaShape(schema, reservedKeys = DEFAULT_RESERVED_SCHEMA_KEYS) {
  if (!Array.isArray(schema)) return false;
  const seenKeys = new Set();
  for (const field of schema) {
    if (!field || typeof field !== 'object' || typeof field.key !== 'string' || field.key.length === 0) {
      return false;
    }
    if (reservedKeys.includes(field.key)) return false;
    if (seenKeys.has(field.key)) return false;
    seenKeys.add(field.key);
  }
  return true;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/schemaValidation.test.js`
Expected: PASS (all schemaValidation tests, including the pre-existing ones, since `/sc-schema`/`/nsc-schema` routes call `validateSchemaShape(schema)` with no second argument and get the same default behavior as before).

- [ ] **Step 5: Write the migration**

Create `db/migrations/033_account_registration_field_schema.sql`:

```sql
-- Admin-editable OT-field schemas, mirroring sc_character_schema/
-- nsc_profile_schema exactly. Seeded with the 7 + 6 fields that exist
-- today as hardcoded columns (see backend/accountFields.js,
-- backend/registrationFields.js) so existing groups.account_fields
-- permission lists keep working unchanged once the data migration lands.
CREATE TABLE account_field_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

INSERT INTO account_field_schema (schema) VALUES ('[
  {"key": "address", "label": "Adresse", "type": "text", "required": false},
  {"key": "birthdate", "label": "Geburtsdatum", "type": "date", "required": false},
  {"key": "phone", "label": "Telefon", "type": "text", "required": false},
  {"key": "emergencyContactLastName", "label": "Notfallkontakt: Name", "type": "text", "required": false},
  {"key": "emergencyContactFirstName", "label": "Notfallkontakt: Vorname", "type": "text", "required": false},
  {"key": "emergencyContactPhone", "label": "Notfallkontakt: Telefonnummer", "type": "text", "required": false},
  {"key": "medicalNotes", "label": "Gesundheitshinweise", "type": "text", "required": false}
]'::jsonb);

CREATE TABLE registration_field_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

INSERT INTO registration_field_schema (schema) VALUES ('[
  {"key": "conTage", "label": "Con-Tage des Spielers", "type": "text", "required": false},
  {"key": "accommodation", "label": "Unterbringung (Hütte/IT-Zelt/OT-Zelt, Anzahl, qm)", "type": "text", "required": false},
  {"key": "craftOffer", "label": "Angebotenes Handwerk", "type": "text", "required": false},
  {"key": "travelMethod", "label": "Anreise (Auto/Motorrad, Bahn, muss abgeholt werden)", "type": "text", "required": false},
  {"key": "dataSharingOptOut", "label": "Daten nicht an andere Teilnehmer weitergeben", "type": "boolean", "required": false},
  {"key": "photoOptOut", "label": "Keine Fotoveröffentlichung", "type": "boolean", "required": false}
]'::jsonb);
```

- [ ] **Step 6: Create the repository + routes files**

Create `backend/accountFieldSchema/repository.js`:

```javascript
import { query } from '../db.js';

export async function getAccountFieldSchema() {
  const { rows } = await query('SELECT schema FROM account_field_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setAccountFieldSchema(schema) {
  const { rows } = await query('SELECT id FROM account_field_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO account_field_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE account_field_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}
```

Create `backend/accountFieldSchema/routes.js`:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getAccountFieldSchema, setAccountFieldSchema } from './repository.js';

const RESERVED_ACCOUNT_FIELD_KEYS = ['id', 'group'];

router.get('/account-schema', requireAuth(async () => {
  const schema = await getAccountFieldSchema();
  return { status: 200, body: schema };
}));

router.put('/account-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema, RESERVED_ACCOUNT_FIELD_KEYS)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id" or "group")' } };
  }
  const saved = await setAccountFieldSchema(schema);
  return { status: 200, body: saved };
})));
```

Create `backend/registrationFieldSchema/repository.js`:

```javascript
import { query } from '../db.js';

export async function getRegistrationFieldSchema() {
  const { rows } = await query('SELECT schema FROM registration_field_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setRegistrationFieldSchema(schema) {
  const { rows } = await query('SELECT id FROM registration_field_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO registration_field_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE registration_field_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}
```

Create `backend/registrationFieldSchema/routes.js`:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { validateSchemaShape } from '../events/schemaValidation.js';
import { getRegistrationFieldSchema, setRegistrationFieldSchema } from './repository.js';

const RESERVED_REGISTRATION_FIELD_KEYS = ['id'];

router.get('/registration-schema', requireAuth(async () => {
  const schema = await getRegistrationFieldSchema();
  return { status: 200, body: schema };
}));

router.put('/registration-schema', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { schema } = body;
  if (!validateSchemaShape(schema, RESERVED_REGISTRATION_FIELD_KEYS)) {
    return { status: 400, body: { error: 'schema must be an array of objects, each with a unique, non-reserved string "key" (not "id")' } };
  }
  const saved = await setRegistrationFieldSchema(schema);
  return { status: 200, body: saved };
})));
```

In `backend/server.js`, add two import lines right after `import './scSchema/routes.js';`:

```javascript
import './accountFieldSchema/routes.js';
import './registrationFieldSchema/routes.js';
```

- [ ] **Step 7: Write the integration tests**

Create `tests/integration/accountFieldSchema.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

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

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Account', 'Schema Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`account-schema-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /account-schema is reachable by any authenticated user and defaults to the 7 built-in account fields', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/account-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const schema = await res.json();
    assert.deepEqual(schema.map((f) => f.key).sort(), [
      'address', 'birthdate', 'emergencyContactFirstName', 'emergencyContactLastName',
      'emergencyContactPhone', 'medicalNotes', 'phone',
    ].sort());
    assert.equal(schema.find((f) => f.key === 'birthdate').type, 'date');
  });
});

test('GET /account-schema requires authentication', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/account-schema`);
    assert.equal(res.status, 401);
  });
});

test('PUT /account-schema rejects a non-admin group', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/account-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ schema: [] }),
    });
    assert.equal(res.status, 403);
  });
});

test('PUT /account-schema updates the schema for an admin caller and rejects the reserved "group" key', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const originalRes = await fetch(`http://localhost:${port}/account-schema`, { headers: { Cookie: cookie } });
    const original = await originalRes.json();
    const newSchema = [{ key: 'shirtSize', label: 'Shirtgröße', type: 'text', required: false }];
    try {
      const putRes = await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: newSchema }),
      });
      assert.equal(putRes.status, 200);
      const getRes = await fetch(`http://localhost:${port}/account-schema`, { headers: { Cookie: cookie } });
      assert.deepEqual(await getRes.json(), newSchema);

      const rejected = await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: [{ key: 'group', label: 'Gruppe', type: 'text' }] }),
      });
      assert.equal(rejected.status, 400);
    } finally {
      await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: original }),
      });
    }
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'account-schema-%'");
  await closePool();
});
```

Create `tests/integration/registrationFieldSchema.test.js` (same shape, adapted to the registration schema):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

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

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Reg', 'Schema Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`reg-schema-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /registration-schema defaults to the 6 built-in registration fields', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/registration-schema`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const schema = await res.json();
    assert.deepEqual(schema.map((f) => f.key).sort(), [
      'accommodation', 'conTage', 'craftOffer', 'dataSharingOptOut', 'photoOptOut', 'travelMethod',
    ].sort());
    assert.equal(schema.find((f) => f.key === 'dataSharingOptOut').type, 'boolean');
  });
});

test('PUT /registration-schema rejects a non-admin group and the reserved "id" key for an admin', async () => {
  await withTestServer(async (port) => {
    const { cookie: memberCookie } = await makeUserAndSession('mitglied');
    const forbidden = await fetch(`http://localhost:${port}/registration-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ schema: [] }),
    });
    assert.equal(forbidden.status, 403);

    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const rejected = await fetch(`http://localhost:${port}/registration-schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ schema: [{ key: 'id', label: 'Id', type: 'text' }] }),
    });
    assert.equal(rejected.status, 400);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'reg-schema-%'");
  await closePool();
});
```

- [ ] **Step 8: Run the new tests**

Run: `node --test tests/unit/schemaValidation.test.js tests/integration/accountFieldSchema.test.js tests/integration/registrationFieldSchema.test.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/events/schemaValidation.js db/migrations/033_account_registration_field_schema.sql backend/accountFieldSchema backend/registrationFieldSchema backend/server.js tests/unit/schemaValidation.test.js tests/integration/accountFieldSchema.test.js tests/integration/registrationFieldSchema.test.js
git commit -m "feat: add admin-editable account/registration field schemas"
```

---

## Task 3: Migrate account data (users/invitations) to one encrypted blob column

**Files:**
- Modify: `backend/accountFields.js`
- Create: `db/migrations/034_account_data_blob.sql`
- Create: `db/migrateAccountDataBlob.js`
- Modify: `backend/accounts/repository.js`
- Modify: `backend/members/repository.js`
- Modify: `backend/invitations/repository.js`
- Modify: `backend/auth/invite.js`
- Modify: `backend/members/routes.js` (only the `createInvitation` call site's params — permission logic untouched, that's Task 5)
- Modify: `package.json`, `docker-compose.yml`, `docker-compose.dev.yml`
- Test: `tests/integration/accounts.test.js`, `tests/integration/members.test.js`, `tests/integration/invitations.test.js`, `tests/integration/schema-users.test.js` (and any other test file the Step 8 grep finds)

**Interfaces:**
- Consumes: `getAccountFieldSchema()` from Task 2.
- Produces: `encryptFieldBlob(values)`/`decryptFieldBlob(buffer)` in `backend/accountFields.js`, replacing `encryptAccountFieldValues`/`decryptEncryptedAccountFields`. `ACCOUNT_FIELD_KEYS` export is UNCHANGED for now (still consumed by `backend/groups/routes.js` and `backend/members/routes.js`'s `filterToAllowedFields` — those switch to the live schema in Task 5, not here).

- [ ] **Step 1: Update the failing test for the new column shape**

In `tests/integration/accounts.test.js`, the existing test `'PATCH /account encrypts and returns sensitive fields; unspecified fields survive a partial update'` asserts against the old columns directly:

```javascript
    const { rows } = await query('SELECT address_enc, emergency_contact_last_name_enc FROM users WHERE id = $1', [userId]);
    assert.notEqual(rows[0].address_enc.toString('utf8'), 'Musterstraße 1, 12345 Musterstadt');
    assert.notEqual(rows[0].emergency_contact_last_name_enc.toString('utf8'), 'Mustermann');
```

Replace with an assertion against the new blob column:

```javascript
    const { rows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [userId]);
    const rawBlob = rows[0].account_data_enc.toString('utf8');
    assert.ok(!rawBlob.includes('Musterstraße 1, 12345 Musterstadt'));
    assert.ok(!rawBlob.includes('Mustermann'));
```

Also add `const { migrateAccountDataBlob } = await import('../../db/migrateAccountDataBlob.js');` and `await migrateAccountDataBlob();` right after the existing `await seedNscProfileSchema();` line, so the test DB ends up in the final (old columns dropped) shape.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/integration/accounts.test.js`
Expected: FAIL — `db/migrateAccountDataBlob.js` doesn't exist yet, and `account_data_enc`/the drop of the old columns don't exist yet either.

- [ ] **Step 3: Shrink `backend/accountFields.js` to the two blob helpers**

Replace the whole file with:

```javascript
import { encryptField, decryptField } from './crypto/fieldCrypto.js';

// OT (out-of-time) account fields -- the field DEFINITIONS (key, label,
// type) now live in the admin-editable account_field_schema (see
// backend/accountFieldSchema). This list only tracks the current set of
// keys for callers that still need a static list; migrated to the live
// schema in a later task (see backend/groups/routes.js,
// backend/members/routes.js). 'group' is deliberately included here even
// though it's excluded from the schema -- it's an access-control field,
// not personal data, gated by the same permission list.
export const ACCOUNT_FIELD_KEYS = [
  'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone',
  'medicalNotes', 'group',
];

// Encrypts/decrypts the single JSON blob of account (OT) field values --
// replaces one *_enc column per field now that the field set is dynamic
// (admin-editable via account_field_schema).
export function encryptFieldBlob(values) {
  return encryptField(JSON.stringify(values ?? {}));
}

export function decryptFieldBlob(buffer) {
  const json = decryptField(buffer);
  return json ? JSON.parse(json) : {};
}
```

- [ ] **Step 4: Rewrite `backend/accounts/repository.js`**

Replace the whole file with:

```javascript
import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    hotkeys: row.hotkeys,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    group: { key: row.group_key, name: row.group_name },
    menus: row.visible_menus,
    canEditCharacters: row.can_edit_characters,
    accountFields: row.account_fields,
    canOverrideCheckinStatus: row.can_override_checkin_status,
    emailVerified: row.email_verified,
    ...decryptFieldBlob(row.account_data_enc),
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.hotkeys,
  users.account_data_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields, groups.can_override_checkin_status
`;

const FROM_JOIN = `FROM users JOIN groups ON groups.id = users.group_id`;

export async function getAccount(userId) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE users.id = $1`, [userId]);
  if (rows.length === 0) return null;
  return decryptAccount(rows[0]);
}

export async function updateAccount(userId, fields) {
  const schema = await getAccountFieldSchema();
  const { rows: currentRows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [userId]);
  if (currentRows.length === 0) return null;
  const nextData = decryptFieldBlob(currentRows[0].account_data_enc);
  for (const field of schema) {
    if (fields[field.key] !== undefined) nextData[field.key] = fields[field.key];
  }

  // Merges into the blob in JS rather than one atomic UPDATE ... COALESCE
  // per column (impossible once the field set is dynamic) -- two
  // concurrent PATCH /account calls touching different fields on the same
  // account can race, last write wins. Accepted tradeoff of the
  // single-blob model (design spec 2026-09-17, section 9).
  const { rows } = await query(
    `UPDATE users SET
       first_name = COALESCE($2, first_name),
       last_name = COALESCE($3, last_name),
       nickname = COALESCE($4, nickname),
       hotkeys = COALESCE($5, hotkeys),
       account_data_enc = $6
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      fields.hotkeys !== undefined ? JSON.stringify(fields.hotkeys) : null,
      encryptFieldBlob(nextData),
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}
```

- [ ] **Step 5: Rewrite `backend/members/repository.js`**

Replace the whole file with:

```javascript
import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.deactivated_at,
  users.account_data_enc,
  groups.id AS group_id, groups.key AS group_key, groups.name AS group_name
`;

function decryptMember(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    emailVerified: row.email_verified,
    status: row.deactivated_at ? 'deactivated' : 'active',
    deactivatedAt: row.deactivated_at,
    group: { id: row.group_id, key: row.group_key, name: row.group_name },
    ...decryptFieldBlob(row.account_data_enc),
  };
}

export async function listMembers(includeDeactivated = false) {
  const where = includeDeactivated ? '' : 'WHERE users.deactivated_at IS NULL';
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users JOIN groups ON groups.id = users.group_id ${where} ORDER BY users.last_name, users.first_name`
  );
  return rows.map(decryptMember);
}

export async function getMember(id) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const member = decryptMember(rows[0]);
  const { rows: characterRows } = await query(
    `SELECT characters.id, characters.name, registrations.event_id, events.name AS event_name
     FROM characters
     JOIN registrations ON registrations.character_id = characters.id
     JOIN events ON events.id = registrations.event_id
     WHERE characters.user_id = $1 ORDER BY events.event_date DESC`,
    [id]
  );
  member.characters = characterRows.map((r) => ({ id: r.id, name: r.name, eventId: r.event_id, eventName: r.event_name }));
  return member;
}

export async function updateMember(id, fields) {
  const schema = await getAccountFieldSchema();
  const { rows: currentRows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [id]);
  if (currentRows.length === 0) return null;
  const nextData = decryptFieldBlob(currentRows[0].account_data_enc);
  for (const field of schema) {
    if (fields[field.key] !== undefined) nextData[field.key] = fields[field.key];
  }

  const { rows } = await query(
    `UPDATE users SET
       group_id = COALESCE($2, group_id),
       first_name = COALESCE($3, first_name),
       last_name = COALESCE($4, last_name),
       nickname = COALESCE($5, nickname),
       account_data_enc = $6
     WHERE id = $1
     RETURNING id`,
    [
      id,
      fields.group ?? null,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      encryptFieldBlob(nextData),
    ]
  );
  if (rows.length === 0) return null;
  return getMember(id);
}

export async function deactivateMember(id) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'UPDATE users SET deactivated_at = COALESCE(deactivated_at, now()) WHERE id = $1 RETURNING id',
      [id]
    );
    if (rows.length === 0) return null;
    await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return rows[0];
  });
}

export async function reactivateMember(id) {
  const { rows } = await query(
    'UPDATE users SET deactivated_at = NULL WHERE id = $1 RETURNING id',
    [id]
  );
  return rows[0] ?? null;
}

export async function deleteMember(id) {
  const { rows } = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  return rows[0] ?? null;
}
```

- [ ] **Step 6: Rewrite `backend/invitations/repository.js`**

Replace the whole file with:

```javascript
import crypto from 'node:crypto';
import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../accountFields.js';

const SELECT_COLUMNS = `
  id, token, email, first_name, last_name, nickname, group_id,
  account_data_enc,
  event_id, cancelled_at,
  invited_by, expires_at, created_at, redeemed_at
`;

function decryptInvitation(row) {
  return {
    id: row.id,
    token: row.token,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    groupId: row.group_id,
    eventId: row.event_id,
    cancelledAt: row.cancelled_at,
    ...decryptFieldBlob(row.account_data_enc),
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    redeemedAt: row.redeemed_at,
  };
}

export async function createInvitation({ email, firstName, lastName, nickname, groupId, invitedBy, eventId, ttlDays = 3, ...otFields }) {
  const schema = await getAccountFieldSchema();
  const data = {};
  for (const field of schema) {
    if (otFields[field.key] !== undefined) data[field.key] = otFields[field.key];
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const { rows } = await query(
    `INSERT INTO invitations (token, email, first_name, last_name, nickname, group_id, account_data_enc, event_id, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SELECT_COLUMNS}`,
    [token, email, firstName, lastName, nickname ?? null, groupId, encryptFieldBlob(data), eventId ?? null, invitedBy, expiresAt]
  );
  return decryptInvitation(rows[0]);
}

export async function getInvitationByToken(token) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM invitations WHERE token = $1`, [token]);
  return rows[0] ? decryptInvitation(rows[0]) : null;
}

export async function getInvitationById(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM invitations WHERE id = $1`, [id]);
  return rows[0] ? decryptInvitation(rows[0]) : null;
}

export async function regenerateToken(id, ttlDays = 3) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const { rows } = await query(
    `UPDATE invitations SET token = $2, expires_at = $3
     WHERE id = $1 AND redeemed_at IS NULL
     RETURNING ${SELECT_COLUMNS}`,
    [id, token, expiresAt]
  );
  return rows[0] ? decryptInvitation(rows[0]) : null;
}

export async function markRedeemed(id, client) {
  const runner = client ?? { query };
  const { rows } = await runner.query(
    'UPDATE invitations SET redeemed_at = now() WHERE id = $1 AND redeemed_at IS NULL RETURNING id',
    [id]
  );
  return rows.length > 0;
}

export async function listOpenInvitations() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM invitations WHERE redeemed_at IS NULL AND cancelled_at IS NULL ORDER BY created_at DESC`
  );
  return rows.map(decryptInvitation);
}

export async function cancelInvitation(id) {
  const { rows } = await query(
    'UPDATE invitations SET cancelled_at = now() WHERE id = $1 AND cancelled_at IS NULL RETURNING id',
    [id]
  );
  return rows.length > 0;
}

export async function listOpenInvitationsForEvent(eventId) {
  const { rows } = await query(
    `SELECT i.id, i.email, i.first_name, i.last_name, i.nickname
     FROM invitations i
     LEFT JOIN users u ON u.email = i.email
     LEFT JOIN registrations r ON r.user_id = u.id AND r.event_id = i.event_id
     WHERE i.event_id = $1
       AND i.cancelled_at IS NULL
       AND r.user_id IS NULL
       AND (i.redeemed_at IS NOT NULL OR i.expires_at > now())
     ORDER BY i.created_at`,
    [eventId]
  );
  return rows.map((r) => ({
    invitationId: r.id,
    email: r.email,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
  }));
}
```

- [ ] **Step 7: Update `backend/auth/invite.js`'s redemption INSERT**

Replace the `INSERT INTO users` call inside `withTransaction` with:

```javascript
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, group_id, first_name, last_name, nickname, email_verified, account_data_enc)
         VALUES ($1, $2, $3, $4, $5, $6, true, (SELECT account_data_enc FROM invitations WHERE id = $7))
         RETURNING id`,
        [invitation.email, passwordHash, invitation.groupId, invitation.firstName, invitation.lastName, invitation.nickname ?? null, invitation.id]
      );
```

- [ ] **Step 8: Update `backend/members/routes.js`'s `createInvitation` call**

In the `POST /members/invite` handler, replace:

```javascript
  const invitation = await createInvitation({
    email: email.toLowerCase(),
    firstName,
    lastName,
    nickname,
    groupId: groupRows[0].id,
    invitedBy: user.id,
    eventId: eventId || undefined,
    address: rest.address,
    birthdate: rest.birthdate,
    phone: rest.phone,
    emergencyContactLastName: rest.emergencyContactLastName,
    emergencyContactFirstName: rest.emergencyContactFirstName,
    emergencyContactPhone: rest.emergencyContactPhone,
    medicalNotes: rest.medicalNotes,
    ttlDays: invitationTtlDays,
  });
```

with:

```javascript
  const invitation = await createInvitation({
    email: email.toLowerCase(),
    firstName,
    lastName,
    nickname,
    groupId: groupRows[0].id,
    invitedBy: user.id,
    eventId: eventId || undefined,
    ttlDays: invitationTtlDays,
    ...rest,
  });
```

(`rest` already excludes `group`/`eventId`/`sendEmail` per the existing destructure a few lines above — `createInvitation` now filters `rest`'s keys against the live schema itself, so passing the whole object is safe and correct.)

- [ ] **Step 9: Write the migration and the one-time backfill script**

Create `db/migrations/034_account_data_blob.sql`:

```sql
-- Adds the new single-blob encrypted OT-field column. The 7 old per-field
-- *_enc columns are dropped by db/migrateAccountDataBlob.js instead of
-- here -- that script must decrypt each old column (needs ENCRYPTION_KEY,
-- application-level AES-256-GCM) before it's safe to drop them, which pure
-- SQL cannot do. Run `npm run migrate-account-data-blob` once after this
-- migration, before relying on the old columns being gone.
ALTER TABLE users ADD COLUMN account_data_enc bytea;
ALTER TABLE invitations ADD COLUMN account_data_enc bytea;
```

Create `db/migrateAccountDataBlob.js`:

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { decryptField } from '../backend/crypto/fieldCrypto.js';
import { encryptFieldBlob } from '../backend/accountFields.js';

const OLD_COLUMNS = {
  address: 'address_enc',
  birthdate: 'birthdate_enc',
  phone: 'phone_enc',
  emergencyContactLastName: 'emergency_contact_last_name_enc',
  emergencyContactFirstName: 'emergency_contact_first_name_enc',
  emergencyContactPhone: 'emergency_contact_phone_enc',
  medicalNotes: 'medical_notes_enc',
};
const OLD_COLUMN_NAMES = Object.values(OLD_COLUMNS);

// One-time, idempotent data migration: decrypts the 7 old per-field
// encrypted columns on users/invitations, merges them into a single JSON
// blob, and writes it to the new account_data_enc column -- can't be a
// plain .sql migration (see db/migrations/034_account_data_blob.sql)
// because the transform needs ENCRYPTION_KEY-based application crypto, not
// anything expressible in pure SQL. Drops the old columns itself, in the
// same transaction as the backfill, once every row has been converted.
export async function migrateAccountDataBlob() {
  await withTransaction(async (client) => {
    const { rows: existingColumns } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = ANY($1)`,
      [OLD_COLUMN_NAMES]
    );
    if (existingColumns.length === 0) {
      logger.info('account data blob migration skipped: old columns already dropped');
      return;
    }

    for (const table of ['users', 'invitations']) {
      const { rows } = await client.query(`SELECT id, ${OLD_COLUMN_NAMES.join(', ')} FROM ${table}`);
      for (const row of rows) {
        const data = {};
        for (const [key, column] of Object.entries(OLD_COLUMNS)) {
          const value = decryptField(row[column]);
          if (value !== null) data[key] = value;
        }
        await client.query(`UPDATE ${table} SET account_data_enc = $1 WHERE id = $2`, [encryptFieldBlob(data), row.id]);
      }
    }

    await client.query(`ALTER TABLE users ${OLD_COLUMN_NAMES.map((c) => `DROP COLUMN ${c}`).join(', ')}`);
    await client.query(`ALTER TABLE invitations ${OLD_COLUMN_NAMES.map((c) => `DROP COLUMN ${c}`).join(', ')}`);
    logger.info('account data blob migration complete');
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrateAccountDataBlob()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('account data blob migration failed', { error: err.message });
      process.exit(1);
    });
}
```

In `package.json`, add a new script (after `"seed-admin"`):

```json
    "migrate-account-data-blob": "node db/migrateAccountDataBlob.js"
```

In `docker-compose.yml` and `docker-compose.dev.yml`, insert `npm run migrate-account-data-blob` into the startup chain, right after `npm run seed-admin`. `docker-compose.yml`'s line becomes:

```
    command: sh -c "npm run migrate && npm run seed-groups && npm run seed-nsc-schema && npm run seed-admin && npm run migrate-account-data-blob && npm start"
```

`docker-compose.dev.yml`'s line becomes the same but ending in `npm run dev`.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test tests/integration/accounts.test.js`
Expected: PASS

- [ ] **Step 11: Fix `tests/integration/invitations.test.js`'s direct column references**

This file has two assertions reading the old columns directly. Replace:

```javascript
  const { rows } = await query('SELECT medical_notes_enc FROM invitations WHERE id = $1', [invitation.id]);
  assert.notEqual(rows[0].medical_notes_enc.toString('utf8'), 'keine');
```

with:

```javascript
  const { rows } = await query('SELECT account_data_enc FROM invitations WHERE id = $1', [invitation.id]);
  assert.ok(!rows[0].account_data_enc.toString('utf8').includes('keine'));
```

and replace:

```javascript
    const { rows } = await query('SELECT email_verified, group_id, address_enc FROM users WHERE id = $1', [(await res.json()).id]);
```

```javascript
    assert.notEqual(rows[0].address_enc.toString('utf8'), 'Teststraße 1');
```

with:

```javascript
    const { rows } = await query('SELECT email_verified, group_id, account_data_enc FROM users WHERE id = $1', [(await res.json()).id]);
```

```javascript
    assert.ok(!rows[0].account_data_enc.toString('utf8').includes('Teststraße 1'));
```

Also add `const { migrateAccountDataBlob } = await import('../../db/migrateAccountDataBlob.js'); await migrateAccountDataBlob();` right after this file's existing `runMigrations()`/seed setup, so its DB ends up in the final (old columns dropped) shape — confirmed via `grep -n "_enc" tests/integration/invitations.test.js` that these are the only two hits in this file.

- [ ] **Step 12: Add the "old columns gone" assertion to `tests/integration/schema-users.test.js`**

This file currently does not set `ENCRYPTION_KEY` (it has never needed to — nothing it imports touches encrypted fields). After this task, `backend/accountFields.js` (transitively imported if this file calls `migrateAccountDataBlob`) fails fast at import time without it. Add near the top, right after the existing `process.env.DATABASE_URL = ...` block:

```javascript
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
```

Add after the existing `await seedGroups();` line:

```javascript
const { migrateAccountDataBlob } = await import('../../db/migrateAccountDataBlob.js');
await migrateAccountDataBlob();
```

Add a new test, matching this file's existing style (e.g. `'users.name column no longer exists after migration'`):

```javascript
test('users.address_enc column no longer exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'address_enc'`
  );
  assert.equal(rows.length, 0);
});

test('users.account_data_enc column exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'account_data_enc'`
  );
  assert.equal(rows.length, 1);
});
```

- [ ] **Step 13: Confirm no other file needs changes, then run the tests**

Run:

```bash
grep -rn "address_enc\|birthdate_enc\|phone_enc\|emergency_contact_.*_enc\|medical_notes_enc\|decryptEncryptedAccountFields\|encryptAccountFieldValues\|ENCRYPTED_ACCOUNT_FIELD_COLUMNS" backend frontend tests db
```

Expected hits after Steps 11-12: only `backend/groups/routes.js` and `backend/members/routes.js` (still import `ACCOUNT_FIELD_KEYS` from `accountFields.js` — that export is unchanged until Task 5) and this plan file's own text if it's grepped by mistake. Anything else is a miss — fix it the same way as Steps 11-12 before proceeding.

Run: `node --test tests/integration/accounts.test.js tests/integration/members.test.js tests/integration/invitations.test.js tests/integration/schema-users.test.js`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add backend/accountFields.js backend/accounts/repository.js backend/members/repository.js backend/invitations/repository.js backend/auth/invite.js backend/members/routes.js db/migrations/034_account_data_blob.sql db/migrateAccountDataBlob.js package.json docker-compose.yml docker-compose.dev.yml tests/integration/accounts.test.js tests/integration/invitations.test.js tests/integration/schema-users.test.js
git commit -m "feat: migrate account/invitation OT fields to one encrypted blob column"
```

---

## Task 4: Migrate registration data (registrations table) to one encrypted blob column

**Files:**
- Modify: `backend/registrationFields.js`
- Create: `db/migrations/035_registration_data_blob.sql`
- Create: `db/migrateRegistrationDataBlob.js`
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Modify: `package.json`, `docker-compose.yml`, `docker-compose.dev.yml`
- Test: `tests/integration/registrations.test.js`, `tests/integration/schema-registrations.test.js` (and any other file the grep step finds)

**Interfaces:**
- Consumes: `getRegistrationFieldSchema()` from Task 2.
- Produces: `encryptFieldBlob(values)`/`decryptFieldBlob(buffer)` in `backend/registrationFields.js` (same shape as Task 3's `accountFields.js` helpers, kept as a separate file/table since the two schemas stay conceptually distinct per the spec). `REGISTRATION_FIELD_KEYS` export UNCHANGED for now (Task 5 migrates its consumers to the live schema).

- [ ] **Step 1: Shrink `backend/registrationFields.js` to the two blob helpers**

Replace the whole file with:

```javascript
import { encryptField, decryptField } from './crypto/fieldCrypto.js';

// The 6 event-scoped OT fields on registrations -- field DEFINITIONS now
// live in the admin-editable registration_field_schema (see
// backend/registrationFieldSchema). This list only tracks the current set
// of keys for callers that still need a static list; migrated to the live
// schema in a later task (see backend/groups/routes.js).
export const REGISTRATION_FIELD_KEYS = [
  'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut',
];

export function encryptFieldBlob(values) {
  return encryptField(JSON.stringify(values ?? {}));
}

export function decryptFieldBlob(buffer) {
  const json = decryptField(buffer);
  return json ? JSON.parse(json) : {};
}
```

- [ ] **Step 2: Confirm the existing tests need no direct changes, then run to verify failure**

`tests/integration/registrations.test.js` (confirmed via `grep -n "_enc" tests/integration/registrations.test.js` — zero hits) never asserts against the raw `*_enc` columns; its OT-field tests (e.g. `'registering with otFields stores them, returned decrypted via GET /registrations'`) only go through the HTTP API, sending and asserting values like `otFields: { conTage: '3', dataSharingOptOut: 'Ja' }` / `registration.dataSharingOptOut === 'Ja'`. Since this task adds no value validation or type coercion (matching the Global Constraints), these tests keep passing unchanged against the new blob storage — no edits needed to this file for Task 4's own purposes (Task 5 doesn't touch it either). It already sets `ENCRYPTION_KEY`, so no env setup gap here.

Run: `node --test tests/integration/registrations.test.js`
Expected: FAIL — not because of this file's own assertions, but because `backend/registrations/repository.js` still references the old columns/helpers this task is about to remove in Step 4, and `registerForEvent`'s INSERT will error once Step 4's later edits land without Step 4 being complete yet. (If it unexpectedly still passes at this point, that's fine too — it confirms Step 1 alone didn't break anything; the meaningful regression check is Step 7, after the repository rewrite.)

- [ ] **Step 3: Rewrite the OT-field parts of `backend/registrations/repository.js`**

Replace the imports at the top:

```javascript
import { ENCRYPTED_ACCOUNT_FIELD_COLUMNS } from '../accountFields.js';
```

with:

```javascript
import { decryptFieldBlob as decryptAccountFieldBlob } from '../accountFields.js';
```

and replace:

```javascript
import { ENCRYPTED_REGISTRATION_FIELD_COLUMNS, decryptEncryptedRegistrationFields, encryptRegistrationFieldValues } from '../registrationFields.js';
```

with:

```javascript
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
import { encryptFieldBlob, decryptFieldBlob } from '../registrationFields.js';
```

Replace `registerForEvent`'s INSERT (keep everything else in the function unchanged):

```javascript
  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id, con_role, character_id, registration_data_enc)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at`,
      [userId, eventId, conRole, resolvedCharacterId, encryptFieldBlob(otFields ?? {})]
    );
    return rows[0];
  } catch (err) {
```

Replace `listParticipantsForEvent`'s OT-field handling:

```javascript
export async function listParticipantsForEvent(eventId, { schema = [], viewer } = {}) {
  const otKeys = (viewer?.group?.accountFields ?? []).filter((key) => key !== 'group');

  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.checked_in_at, r.checked_out_at,
            u.account_data_enc, r.registration_data_enc
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
```

and further down, replace the `registered` mapping's `otFields` construction:

```javascript
  const registered = registrations.map((r) => {
    const accountData = decryptAccountFieldBlob(r.account_data_enc);
    const registrationData = decryptFieldBlob(r.registration_data_enc);
    const otFields = {};
    for (const key of otKeys) {
      if (key in accountData) otFields[key] = accountData[key];
      else if (key in registrationData) otFields[key] = registrationData[key];
    }
    return {
      userId: r.user_id,
      invitationId: null,
      name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
      status: r.status,
      conRole: r.con_role,
      checkedInAt: r.checked_in_at,
      checkedOutAt: r.checked_out_at,
      characters: charactersByUser.get(r.user_id) ?? [],
      otFields,
    };
  });
```

(This can no longer select only the permitted columns at the SQL level — since both blobs are single opaque columns, every row's two blobs are always fetched and decrypted, then filtered to `otKeys` in JS. This is a minor, unavoidable consequence of dynamic field sets; the filtering guarantee — a caller only ever sees keys their group is permitted to see — is preserved exactly.)

Replace `listRegistrationsForUser`:

```javascript
export async function listRegistrationsForUser(userId) {
  const { rows } = await query(
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.checked_in_at, r.checked_out_at,
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
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    ...decryptFieldBlob(r.registration_data_enc),
  }));
}
```

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

- [ ] **Step 4: Update `backend/registrations/routes.js`'s `/ot-fields` permission check**

Replace:

```javascript
import { REGISTRATION_FIELD_KEYS } from '../registrationFields.js';
```

with:

```javascript
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';
```

and in the `PUT /events/:id/registrations/:userId/ot-fields` handler, replace:

```javascript
  if (!isOwner) {
    const disallowed = Object.keys(body).filter((key) => REGISTRATION_FIELD_KEYS.includes(key) && !user.group.accountFields.includes(key));
    if (disallowed.length > 0) {
      return { status: 400, body: { error: `not permitted to edit: ${disallowed.join(', ')}` } };
    }
  }
```

with:

```javascript
  if (!isOwner) {
    const registrationFieldKeys = (await getRegistrationFieldSchema()).map((f) => f.key);
    const disallowed = Object.keys(body).filter((key) => registrationFieldKeys.includes(key) && !user.group.accountFields.includes(key));
    if (disallowed.length > 0) {
      return { status: 400, body: { error: `not permitted to edit: ${disallowed.join(', ')}` } };
    }
  }
```

and further down, replace:

```javascript
  if (!isOwner) {
    for (const key of REGISTRATION_FIELD_KEYS) {
      if (!user.group.accountFields.includes(key)) delete registration[key];
    }
  }
```

with:

```javascript
  if (!isOwner) {
    const registrationFieldKeys = (await getRegistrationFieldSchema()).map((f) => f.key);
    for (const key of registrationFieldKeys) {
      if (!user.group.accountFields.includes(key)) delete registration[key];
    }
  }
```

- [ ] **Step 5: Write the migration and the one-time backfill script**

Create `db/migrations/035_registration_data_blob.sql`:

```sql
-- Adds the new single-blob encrypted OT-field column for registrations.
-- See db/migrateRegistrationDataBlob.js for why the old 6 *_enc columns
-- are dropped there instead of here (needs ENCRYPTION_KEY-based
-- application crypto to backfill, not expressible in pure SQL).
ALTER TABLE registrations ADD COLUMN registration_data_enc bytea;
```

Create `db/migrateRegistrationDataBlob.js`:

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { decryptField } from '../backend/crypto/fieldCrypto.js';
import { encryptFieldBlob } from '../backend/registrationFields.js';

const OLD_COLUMNS = {
  conTage: 'con_tage_enc',
  accommodation: 'accommodation_enc',
  craftOffer: 'craft_offer_enc',
  travelMethod: 'travel_method_enc',
  dataSharingOptOut: 'data_sharing_opt_out_enc',
  photoOptOut: 'photo_opt_out_enc',
};
const OLD_COLUMN_NAMES = Object.values(OLD_COLUMNS);

// One-time, idempotent data migration -- see db/migrateAccountDataBlob.js
// for the equivalent on users/invitations; same reasoning, one table here.
export async function migrateRegistrationDataBlob() {
  await withTransaction(async (client) => {
    const { rows: existingColumns } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'registrations' AND column_name = ANY($1)`,
      [OLD_COLUMN_NAMES]
    );
    if (existingColumns.length === 0) {
      logger.info('registration data blob migration skipped: old columns already dropped');
      return;
    }

    const { rows } = await client.query(`SELECT user_id, event_id, ${OLD_COLUMN_NAMES.join(', ')} FROM registrations`);
    for (const row of rows) {
      const data = {};
      for (const [key, column] of Object.entries(OLD_COLUMNS)) {
        const value = decryptField(row[column]);
        if (value !== null) data[key] = value;
      }
      await client.query(
        'UPDATE registrations SET registration_data_enc = $1 WHERE user_id = $2 AND event_id = $3',
        [encryptFieldBlob(data), row.user_id, row.event_id]
      );
    }

    await client.query(`ALTER TABLE registrations ${OLD_COLUMN_NAMES.map((c) => `DROP COLUMN ${c}`).join(', ')}`);
    logger.info('registration data blob migration complete');
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrateRegistrationDataBlob()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('registration data blob migration failed', { error: err.message });
      process.exit(1);
    });
}
```

In `package.json`, add (after `"migrate-account-data-blob"`):

```json
    "migrate-registration-data-blob": "node db/migrateRegistrationDataBlob.js"
```

In `docker-compose.yml` and `docker-compose.dev.yml`, extend the chain again:

```
    command: sh -c "npm run migrate && npm run seed-groups && npm run seed-nsc-schema && npm run seed-admin && npm run migrate-account-data-blob && npm run migrate-registration-data-blob && npm start"
```

(`docker-compose.dev.yml` ending in `npm run dev` as before.)

- [ ] **Step 6: Run to verify the test passes**

Run: `node --test tests/integration/registrations.test.js`
Expected: PASS

- [ ] **Step 7: Add the "old columns gone" assertion to `tests/integration/schema-registrations.test.js`**

This file (confirmed via `grep -n "_enc" tests/integration/schema-registrations.test.js` — zero hits, so no raw-SQL fixes needed there) doesn't set `ENCRYPTION_KEY`. Add near the top, right after the existing `process.env.DATABASE_URL = ...` block:

```javascript
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
```

Add after the existing `await seedGroups();` line:

```javascript
const { migrateRegistrationDataBlob } = await import('../../db/migrateRegistrationDataBlob.js');
await migrateRegistrationDataBlob();
```

Add two new tests, matching this file's existing style:

```javascript
test('registrations.con_tage_enc column no longer exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'registrations' AND column_name = 'con_tage_enc'`
  );
  assert.equal(rows.length, 0);
});

test('registrations.registration_data_enc column exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'registrations' AND column_name = 'registration_data_enc'`
  );
  assert.equal(rows.length, 1);
});
```

(`query`/`closePool` are already imported near the top of this file — reuse them, and add `closePool` to the existing `test.after` if it isn't already there.)

- [ ] **Step 8: Confirm no other file needs changes**

Run:

```bash
grep -rn "con_tage_enc\|accommodation_enc\|craft_offer_enc\|travel_method_enc\|data_sharing_opt_out_enc\|photo_opt_out_enc\|decryptEncryptedRegistrationFields\|encryptRegistrationFieldValues\|ENCRYPTED_REGISTRATION_FIELD_COLUMNS" backend frontend tests db
```

Expected hits after Step 7: only `backend/groups/routes.js` (still imports `REGISTRATION_FIELD_KEYS` from `registrationFields.js` — untouched until Task 5). Anything else is a miss — fix it the same way as Step 7 before proceeding.

Re-run: `node --test tests/integration/registrations.test.js tests/integration/schema-registrations.test.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/registrationFields.js backend/registrations/repository.js backend/registrations/routes.js db/migrations/035_registration_data_blob.sql db/migrateRegistrationDataBlob.js package.json docker-compose.yml docker-compose.dev.yml tests/integration/registrations.test.js tests/integration/schema-registrations.test.js
git commit -m "feat: migrate registration OT fields to one encrypted blob column"
```

---

## Task 5: Dynamic group-permission validation + dynamic field checkboxes in the admin UI

**Files:**
- Modify: `backend/accountFields.js` (remove now-dead `ACCOUNT_FIELD_KEYS` export)
- Modify: `backend/registrationFields.js` (remove now-dead `REGISTRATION_FIELD_KEYS` export)
- Modify: `backend/groups/routes.js`
- Modify: `backend/members/routes.js`
- Modify: `frontend/admin/groups.html`
- Test: `tests/integration/groups.test.js`, `tests/integration/members.test.js`

**Interfaces:**
- Consumes: `getAccountFieldSchema()`, `getRegistrationFieldSchema()`.
- Produces: `backend/groups/routes.js`'s field-list validation now checks against `[...accountKeys, ...registrationKeys]` fetched live per-request, not a static import.

- [ ] **Step 1: Write the failing test**

`tests/integration/groups.test.js` already defines `makeUserAndSession(groupKey)` and uses the `createServer().listen(0)` + try/finally pattern (not `withTestServer`) — match that exactly. Add this test near the other `accountFields` validation tests:

```javascript
test('POST /groups accepts a newly-admin-added account-schema field key in accountFields', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const schemaRes = await fetch(`http://localhost:${port}/account-schema`, { headers: { Cookie: cookie } });
    const originalSchema = await schemaRes.json();
    const newSchema = [...originalSchema, { key: 'newTestField', label: 'Neues Testfeld', type: 'text', required: false }];
    try {
      await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: newSchema }),
      });

      const res = await fetch(`http://localhost:${port}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ key: `test_group_${crypto.randomUUID().slice(0, 8)}`, name: 'Test Group', accountFields: ['newTestField'] }),
      });
      assert.equal(res.status, 201);
    } finally {
      await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: originalSchema }),
      });
    }
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/integration/groups.test.js`
Expected: FAIL — `newTestField` isn't in the static `ACCOUNT_FIELD_KEYS`/`REGISTRATION_FIELD_KEYS` lists yet, so `POST /groups` rejects it with 400.

- [ ] **Step 3: Make `backend/groups/routes.js` validate against the live schemas**

Replace:

```javascript
import { ACCOUNT_FIELD_KEYS } from '../accountFields.js';
import { REGISTRATION_FIELD_KEYS } from '../registrationFields.js';

const MENU_KEYS = ['konto', 'mitglieder', 'events', 'checkin'];
const KEY_PATTERN = /^[a-z0-9_]+$/;
const ALLOWED_ACCOUNT_FIELD_KEYS = [...ACCOUNT_FIELD_KEYS, ...REGISTRATION_FIELD_KEYS];

function isValidMenuList(value) {
  return Array.isArray(value) && value.every((v) => MENU_KEYS.includes(v));
}

function isValidFieldList(value) {
  return Array.isArray(value) && value.every((v) => ALLOWED_ACCOUNT_FIELD_KEYS.includes(v));
}
```

with:

```javascript
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { getRegistrationFieldSchema } from '../registrationFieldSchema/repository.js';

const MENU_KEYS = ['konto', 'mitglieder', 'events', 'checkin'];
const KEY_PATTERN = /^[a-z0-9_]+$/;

function isValidMenuList(value) {
  return Array.isArray(value) && value.every((v) => MENU_KEYS.includes(v));
}

// 'group' is a hardcoded permission key, never part of either schema.
async function allowedFieldKeys() {
  const [accountSchema, registrationSchema] = await Promise.all([getAccountFieldSchema(), getRegistrationFieldSchema()]);
  return ['group', ...accountSchema.map((f) => f.key), ...registrationSchema.map((f) => f.key)];
}

async function isValidFieldList(value) {
  if (!Array.isArray(value)) return false;
  const allowed = await allowedFieldKeys();
  return value.every((v) => allowed.includes(v));
}
```

Since `isValidFieldList` is now async, update its 4 call sites (`POST /groups`, `PUT /groups/:id`, each calling it twice for the check and the error message). Replace both blocks (identical in `POST /groups` and `PUT /groups/:id`):

```javascript
  if (accountFields !== undefined && !isValidFieldList(accountFields)) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${ALLOWED_ACCOUNT_FIELD_KEYS.join(', ')}` } };
  }
```

with:

```javascript
  if (accountFields !== undefined && !(await isValidFieldList(accountFields))) {
    return { status: 400, body: { error: `accountFields must be an array containing only: ${(await allowedFieldKeys()).join(', ')}` } };
  }
```

- [ ] **Step 4: Make `backend/members/routes.js`'s `filterToAllowedFields` dynamic**

Replace:

```javascript
import { ACCOUNT_FIELD_KEYS } from '../accountFields.js';
import { isValidEmail } from '../validation.js';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

function filterToAllowedFields(body, allowedFields) {
  const disallowed = Object.keys(body).filter((key) => ACCOUNT_FIELD_KEYS.includes(key) && !allowedFields.includes(key));
  return disallowed;
}
```

with:

```javascript
import { getAccountFieldSchema } from '../accountFieldSchema/repository.js';
import { isValidEmail } from '../validation.js';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

async function filterToAllowedFields(body, allowedFields) {
  const schemaKeys = (await getAccountFieldSchema()).map((f) => f.key);
  const accountFieldKeys = ['group', ...schemaKeys];
  return Object.keys(body).filter((key) => accountFieldKeys.includes(key) && !allowedFields.includes(key));
}
```

Update its 2 call sites (`PATCH /members/:id` and `POST /members/invite`) to `await`:

```javascript
  const disallowed = await filterToAllowedFields(body, user.group.accountFields);
```

and

```javascript
  const disallowed = await filterToAllowedFields(fieldsToCheck, user.group.accountFields);
```

- [ ] **Step 5: Remove the now-dead static exports**

In `backend/accountFields.js`, remove the `ACCOUNT_FIELD_KEYS` export entirely (nothing imports it anymore after Steps 3-4). In `backend/registrationFields.js`, remove the `REGISTRATION_FIELD_KEYS` export entirely (same reasoning). Confirm with:

```bash
grep -rn "ACCOUNT_FIELD_KEYS\|REGISTRATION_FIELD_KEYS" backend frontend tests
```

Expected: no hits at all.

- [ ] **Step 6: Update `frontend/admin/groups.html`'s hardcoded field checkboxes**

Replace the hardcoded `<div class="checkbox-group" id="field-checkboxes">...</div>` block's inner `<label>` list (lines with `address`, `birthdate`, ... `photoOptOut`) with just the `group` checkbox, since the rest are now rendered dynamically:

```html
        <div class="checkbox-group" id="field-checkboxes">
          <label><input type="checkbox" value="group"> Gruppe</label>
        </div>
```

In the `<script type="module">` block, add a schema-loading step and a render function. Replace:

```javascript
import { escapeHtml } from '/js/formFields.js';
import { renderNavLinks, renderSidebarUser, initSidebarToggle } from '/js/nav.js';
initSidebarToggle();
```

with:

```javascript
import { escapeHtml } from '/js/formFields.js';
import { renderNavLinks, renderSidebarUser, initSidebarToggle } from '/js/nav.js';
initSidebarToggle();

const fieldCheckboxes = document.getElementById('field-checkboxes');

function appendFieldCheckboxes(schema) {
  fieldCheckboxes.insertAdjacentHTML('beforeend', schema.map((field) =>
    `<label><input type="checkbox" value="${escapeHtml(field.key)}"> ${escapeHtml(field.label ?? field.key)}</label>`
  ).join(''));
}
```

Finally, in the trailing `try { ... }` block that loads the account and calls `loadGroups()`, add the schema fetch right before `await loadGroups();`:

```javascript
  const [accountSchema, registrationSchema] = await Promise.all([api.get('/account-schema'), api.get('/registration-schema')]);
  appendFieldCheckboxes(accountSchema);
  appendFieldCheckboxes(registrationSchema);
  await loadGroups();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/integration/groups.test.js tests/integration/members.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/accountFields.js backend/registrationFields.js backend/groups/routes.js backend/members/routes.js frontend/admin/groups.html tests/integration/groups.test.js
git commit -m "feat: validate group field permissions against the live account/registration schemas"
```

---

## Task 6: Admin schema editor UI for account/registration fields

**Files:**
- Modify: `frontend/admin/character-schema.html`

**Interfaces:**
- Consumes: `GET/PUT /account-schema`, `GET/PUT /registration-schema` from Task 2.

- [ ] **Step 1: Add the two new tabs**

Update the page title/intro and tab bar. Replace:

```html
    <h1>Charakterschema</h1>
    <p class="sub">Legt fest, welche Sheet-Felder Charaktere haben. SC/GSC-Charaktere teilen sich ein Schema über alle Events hinweg; NSC-Charaktere haben ihr eigenes, ebenfalls app-weites Schema.</p>

    <div class="tabs" id="class-tabs">
      <button type="button" class="tab-btn active" data-tab="sc-schema-tab">SC/GSC</button>
      <button type="button" class="tab-btn" data-tab="nsc-schema-tab">NSC</button>
    </div>

    <div class="tab-panel card form-pad" id="sc-schema-tab">
      <div id="sc-schema-rows"></div>
      <button type="button" id="sc-add-field">Feld hinzufügen</button>
      <button type="button" id="sc-load-template">Standard-Vorlage laden</button>
      <button type="button" id="sc-schema-save">Speichern</button>
    </div>

    <div class="tab-panel card form-pad" id="nsc-schema-tab" hidden>
      <div id="nsc-schema-rows"></div>
      <button type="button" id="nsc-add-field">Feld hinzufügen</button>
      <button type="button" id="nsc-schema-save">Speichern</button>
    </div>
```

with:

```html
    <h1>Feldschemas</h1>
    <p class="sub">Legt fest, welche Felder Charaktere (IT) und Konten/Anmeldungen (OT) haben. SC/GSC-Charaktere teilen sich ein Schema über alle Events hinweg; NSC-Charaktere, Konto-Felder und Anmeldungs-Felder haben je ihr eigenes, ebenfalls app-weites Schema.</p>

    <div class="tabs" id="class-tabs">
      <button type="button" class="tab-btn active" data-tab="sc-schema-tab">SC/GSC</button>
      <button type="button" class="tab-btn" data-tab="nsc-schema-tab">NSC</button>
      <button type="button" class="tab-btn" data-tab="account-schema-tab">Konto</button>
      <button type="button" class="tab-btn" data-tab="registration-schema-tab">Anmeldung</button>
    </div>

    <div class="tab-panel card form-pad" id="sc-schema-tab">
      <div id="sc-schema-rows"></div>
      <button type="button" id="sc-add-field">Feld hinzufügen</button>
      <button type="button" id="sc-load-template">Standard-Vorlage laden</button>
      <button type="button" id="sc-schema-save">Speichern</button>
    </div>

    <div class="tab-panel card form-pad" id="nsc-schema-tab" hidden>
      <div id="nsc-schema-rows"></div>
      <button type="button" id="nsc-add-field">Feld hinzufügen</button>
      <button type="button" id="nsc-schema-save">Speichern</button>
    </div>

    <div class="tab-panel card form-pad" id="account-schema-tab" hidden>
      <div id="account-schema-rows"></div>
      <button type="button" id="account-add-field">Feld hinzufügen</button>
      <button type="button" id="account-schema-save">Speichern</button>
    </div>

    <div class="tab-panel card form-pad" id="registration-schema-tab" hidden>
      <div id="registration-schema-rows"></div>
      <button type="button" id="registration-add-field">Feld hinzufügen</button>
      <button type="button" id="registration-schema-save">Speichern</button>
    </div>
```

- [ ] **Step 2: Wire up the two new editors in the script**

Replace:

```javascript
const scRows = setupSchemaEditor({ rowsId: 'sc-schema-rows', addFieldId: 'sc-add-field', saveId: 'sc-schema-save', endpoint: '/sc-schema', loadTemplateId: 'sc-load-template' });
const nscRows = setupSchemaEditor({ rowsId: 'nsc-schema-rows', addFieldId: 'nsc-add-field', saveId: 'nsc-schema-save', endpoint: '/nsc-schema' });
```

with:

```javascript
const scRows = setupSchemaEditor({ rowsId: 'sc-schema-rows', addFieldId: 'sc-add-field', saveId: 'sc-schema-save', endpoint: '/sc-schema', loadTemplateId: 'sc-load-template' });
const nscRows = setupSchemaEditor({ rowsId: 'nsc-schema-rows', addFieldId: 'nsc-add-field', saveId: 'nsc-schema-save', endpoint: '/nsc-schema' });
const accountRows = setupSchemaEditor({ rowsId: 'account-schema-rows', addFieldId: 'account-add-field', saveId: 'account-schema-save', endpoint: '/account-schema' });
const registrationRows = setupSchemaEditor({ rowsId: 'registration-schema-rows', addFieldId: 'registration-add-field', saveId: 'registration-schema-save', endpoint: '/registration-schema' });
```

and replace:

```javascript
    const [scSchema, nscSchema] = await Promise.all([api.get('/sc-schema'), api.get('/nsc-schema')]);
    scSchema.forEach((field) => addSchemaRow(scRows, field));
    nscSchema.forEach((field) => addSchemaRow(nscRows, field));
```

with:

```javascript
    const [scSchema, nscSchema, accountSchema, registrationSchema] = await Promise.all([
      api.get('/sc-schema'), api.get('/nsc-schema'), api.get('/account-schema'), api.get('/registration-schema'),
    ]);
    scSchema.forEach((field) => addSchemaRow(scRows, field));
    nscSchema.forEach((field) => addSchemaRow(nscRows, field));
    accountSchema.forEach((field) => addSchemaRow(accountRows, field));
    registrationSchema.forEach((field) => addSchemaRow(registrationRows, field));
```

`initTabs` already handles any number of `.tab-btn` buttons generically (it queries `tabsEl.querySelectorAll('.tab-btn')`), so the two new tabs work with zero changes there. `addSchemaRow`/`collectSchema` are already generic (they don't know or care which endpoint they're feeding).

- [ ] **Step 3: Manual verification**

This page has no automated DOM test coverage (matches this project's established pattern for admin HTML pages — see `docs/superpowers/plans/2026-09-07-checkin-adhoc-bearbeitung.md`'s notes). If a task implementer's sandbox has no live browser/DB, skip this step and flag it explicitly; the controller performs it independently before the final task, using `docker compose -f docker-compose.dev.yml up`:
1. Open `/admin/character-schema.html` as an admin.
2. Confirm 4 tabs appear: SC/GSC, NSC, Konto, Anmeldung.
3. Click "Konto" — confirm the 7 seeded fields appear with correct labels/types (birthdate should show "Datum" selected).
4. Add a new field (e.g. key `shirtSize`, label "Shirtgröße", type Text), save, reload the page, confirm it persisted.
5. Click "Anmeldung" — confirm the 6 seeded fields appear, with the two opt-outs as "Ja/Nein".

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/character-schema.html
git commit -m "feat: add Konto/Anmeldung tabs to the admin field-schema editor"
```

---

## Task 7: Schema-driven OT field rendering across account/members/checkin pages

**Files:**
- Modify: `frontend/js/formFields.js`
- Modify: `frontend/account.html`
- Modify: `frontend/admin/members.html`
- Modify: `frontend/admin/checkin.html`
- Test: `tests/unit/formFields.test.js`

**Interfaces:**
- Produces: `renderAccountFieldInput(field, value, opts)` — signature changed from `(key, label, value, opts)` to take a full field-definition object `{key, label, type, required, options}`, same shape as IT schema fields, supporting all the same types as `renderField` (`text, textarea, select, number, boolean, multiselect, link, date`), each still wrapped in `<div class="${key}-container">`. New `collectAccountFieldValues(container, schema)` reads values back out via `[data-field]`/`id` attributes (not `name`, unlike `collectFieldValues` — matches this page family's existing DOM convention).

- [ ] **Step 1: Update the failing unit tests**

In `tests/unit/formFields.test.js`, replace the 3 existing `renderAccountFieldInput` tests:

```javascript
test('renderAccountFieldInput renders opt-out keys as checkboxes and others as text', () => {
  const checkboxHtml = renderAccountFieldInput('photoOptOut', 'Keine Fotoveröffentlichung', 'Ja');
  assert.match(checkboxHtml, /type="checkbox"/);
  assert.match(checkboxHtml, / checked/);

  const uncheckedHtml = renderAccountFieldInput('photoOptOut', 'Keine Fotoveröffentlichung', 'Nein');
  assert.doesNotMatch(uncheckedHtml, / checked/);

  const textHtml = renderAccountFieldInput('address', 'Adresse', 'Musterstr. 1');
  assert.match(textHtml, /type="text"/);
  assert.match(textHtml, /value="Musterstr\. 1"/);
});

test('renderAccountFieldInput appends the sealedBadge HTML after the label text when given', () => {
  const html = renderAccountFieldInput('address', 'Adresse', '', { sealedBadge: '<span class="sealed">X</span>' });
  assert.match(html, /Adresse<span class="sealed">X<\/span><\/label>/);
});

test('renderAccountFieldInput namespaces id/for with idPrefix, defaulting to unprefixed', () => {
  const plain = renderAccountFieldInput('address', 'Adresse', '');
  assert.match(plain, /id="field-address"/);
  assert.match(plain, /for="field-address"/);

  const prefixed = renderAccountFieldInput('address', 'Adresse', '', { idPrefix: 'edit-' });
  assert.match(prefixed, /id="edit-field-address"/);
  assert.match(prefixed, /for="edit-field-address"/);
});
```

with:

```javascript
test('renderAccountFieldInput renders a checkbox for type "boolean" and a text input otherwise, both wrapped in a per-field container div', () => {
  const checkboxHtml = renderAccountFieldInput({ key: 'photoOptOut', label: 'Keine Fotoveröffentlichung', type: 'boolean' }, true);
  assert.match(checkboxHtml, /class="photoOptOut-container"/);
  assert.match(checkboxHtml, /type="checkbox"/);
  assert.match(checkboxHtml, / checked/);

  const uncheckedHtml = renderAccountFieldInput({ key: 'photoOptOut', label: 'Keine Fotoveröffentlichung', type: 'boolean' }, false);
  assert.doesNotMatch(uncheckedHtml, / checked/);

  const textHtml = renderAccountFieldInput({ key: 'address', label: 'Adresse', type: 'text' }, 'Musterstr. 1');
  assert.match(textHtml, /class="address-container"/);
  assert.match(textHtml, /type="text"/);
  assert.match(textHtml, /value="Musterstr\. 1"/);
});

test('renderAccountFieldInput supports select, number, multiselect, link, and date types like renderField', () => {
  const selectHtml = renderAccountFieldInput({ key: 'shirtSize', label: 'Shirtgröße', type: 'select', options: ['S', 'M'] }, 'M');
  assert.match(selectHtml, /<select/);
  assert.match(selectHtml, /class="shirtSize-container"/);

  const dateHtml = renderAccountFieldInput({ key: 'birthdate', label: 'Geburtsdatum', type: 'date' }, '2000-01-01');
  assert.match(dateHtml, /type="date"/);
  assert.match(dateHtml, /value="2000-01-01"/);
});

test('renderAccountFieldInput appends the sealedBadge HTML after the label text when given', () => {
  const html = renderAccountFieldInput({ key: 'address', label: 'Adresse', type: 'text' }, '', { sealedBadge: '<span class="sealed">X</span>' });
  assert.match(html, /Adresse<span class="sealed">X<\/span><\/label>/);
});

test('renderAccountFieldInput namespaces id/for with idPrefix, defaulting to unprefixed', () => {
  const plain = renderAccountFieldInput({ key: 'address', label: 'Adresse', type: 'text' }, '');
  assert.match(plain, /id="field-address"/);
  assert.match(plain, /for="field-address"/);

  const prefixed = renderAccountFieldInput({ key: 'address', label: 'Adresse', type: 'text' }, '', { idPrefix: 'edit-' });
  assert.match(prefixed, /id="edit-field-address"/);
  assert.match(prefixed, /for="edit-field-address"/);
});

test('collectAccountFieldValues reads a boolean field from a checkbox and a text field from its value', () => {
  const schema = [
    { key: 'photoOptOut', label: 'Foto', type: 'boolean' },
    { key: 'address', label: 'Adresse', type: 'text' },
  ];
  const fakeInputs = [
    { dataset: { field: 'photoOptOut' }, type: 'checkbox', checked: true },
    { dataset: { field: 'address' }, type: 'text', value: 'Musterstr. 1' },
  ];
  const fakeContainer = { querySelectorAll: () => fakeInputs };
  const result = collectAccountFieldValues(fakeContainer, schema);
  assert.deepEqual(result, { photoOptOut: true, address: 'Musterstr. 1' });
});
```

Update the file's top import to also pull in `collectAccountFieldValues`:

```javascript
import { escapeHtml, renderField, collectFieldValues, renderAccountFieldInput, collectAccountFieldValues } from '../../frontend/js/formFields.js';
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/formFields.test.js`
Expected: FAIL — old signature/behavior, `collectAccountFieldValues` doesn't exist.

- [ ] **Step 3: Rewrite `renderAccountFieldInput` and add `collectAccountFieldValues`**

In `frontend/js/formFields.js`, remove `OPT_OUT_KEYS`, `isOptOutYes`, and the old `renderAccountFieldInput`:

```javascript
// True if a Ja/Nein opt-out field's raw stored value means "yes" (checked).
// These fields are free text at the DB layer, so this also accepts whatever
// case a user typed before the field became a checkbox.
export function isOptOutYes(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'ja';
}

// Free text let a caller type anything besides Ja/Nein; these two are
// rendered as checkboxes everywhere they're editable instead.
export const OPT_OUT_KEYS = ['dataSharingOptOut', 'photoOptOut'];

// Renders one OT (account) field as a labeled input: a checkbox for the two
// Ja/Nein opt-out keys, a text input otherwise. `sealedBadge`, if given, is
// raw HTML appended to the label (e.g. the lock-icon "Verschlüsselt" badge).
// Each field is wrapped in its own `<div class="${key}-container">` -- this
// wrapper carries no styling today and looks removable, but it's a
// deliberate per-field CSS/JS hook the user added for upcoming UI work.
// Do not delete it as "unused" or collapse it back to a bare label+input.
export function renderAccountFieldInput(key, label, value, { sealedBadge = '', idPrefix = '' } = {}) {
  const escapedLabel = escapeHtml(label);
  const id = `${idPrefix}field-${key}`;
  if (OPT_OUT_KEYS.includes(key)) {
    const checked = isOptOutYes(value) ? ' checked' : '';
    return `<div class="${key}-container"><label for="${id}"><input id="${id}" data-field="${key}" type="checkbox"${checked}> ${escapedLabel}${sealedBadge}</label></div>`;
  }
  return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="text" value="${escapeHtml(value ?? '')}"><label for="${id}">${escapedLabel}${sealedBadge}</label></div>`;
}
```

and replace it with:

```javascript
// Renders one OT (account/registration) field from a schema-shaped field
// definition ({key, label, type, options}) -- same field shape as IT
// (character) schema fields. `sealedBadge`, if given, is raw HTML appended
// to the label (e.g. the lock-icon "Verschlüsselt" badge). Each field is
// wrapped in its own `<div class="${key}-container">` -- this wrapper
// carries no styling today and looks removable, but it's a deliberate
// per-field CSS/JS hook the user added for upcoming UI work. Do not delete
// it as "unused" or collapse it back to a bare label+input.
export function renderAccountFieldInput(field, value, { sealedBadge = '', idPrefix = '' } = {}) {
  const { key, type } = field;
  const escapedLabel = escapeHtml(field.label ?? key) + sealedBadge;
  const val = escapeHtml(value);
  const id = `${idPrefix}field-${key}`;

  if (type === 'boolean') {
    const checked = value ? ' checked' : '';
    return `<div class="${key}-container"><label for="${id}"><input id="${id}" data-field="${key}" type="checkbox"${checked}> ${escapedLabel}</label></div>`;
  }
  if (type === 'multiselect' && Array.isArray(field.options)) {
    const selected = Array.isArray(value) ? value : [];
    const checkboxes = field.options.map((opt, i) => {
      const escapedOpt = escapeHtml(opt);
      const checked = selected.includes(opt) ? ' checked' : '';
      return `<label for="${id}-${i}"><input id="${id}-${i}" data-field="${key}" type="checkbox" value="${escapedOpt}"${checked}> ${escapedOpt}</label>`;
    }).join('');
    return `<div class="${key}-container"><span>${escapedLabel}</span>${checkboxes}</div>`;
  }
  if (type === 'number') {
    return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="number" value="${val}"><label for="${id}">${escapedLabel}</label></div>`;
  }
  if (type === 'link') {
    return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="url" value="${val}"><label for="${id}">${escapedLabel}</label></div>`;
  }
  if (type === 'date') {
    return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="date" value="${val}"><label for="${id}">${escapedLabel}</label></div>`;
  }
  if (type === 'textarea') {
    return `<div class="${key}-container"><textarea id="${id}" data-field="${key}">${val}</textarea><label for="${id}">${escapedLabel}</label></div>`;
  }
  if (type === 'select' && Array.isArray(field.options)) {
    const options = field.options.map((opt) => {
      const escapedOpt = escapeHtml(opt);
      const selected = opt === value ? ' selected' : '';
      return `<option value="${escapedOpt}"${selected}>${escapedOpt}</option>`;
    }).join('');
    return `<div class="${key}-container"><select id="${id}" data-field="${key}"><option value=""></option>${options}</select><label for="${id}">${escapedLabel}</label></div>`;
  }
  return `<div class="${key}-container"><input id="${id}" data-field="${key}" type="text" value="${val}"><label for="${id}">${escapedLabel}</label></div>`;
}

// Reads a schema-driven OT-field container's current values back into a
// plain object, keyed by field key. Mirrors collectFieldValues's per-type
// logic, but keys off [data-field] elements (this page family's existing
// DOM convention) instead of a <form>'s `name` attributes.
export function collectAccountFieldValues(container, schema) {
  const result = {};
  const inputsByKey = new Map();
  container.querySelectorAll('[data-field]').forEach((input) => {
    if (!inputsByKey.has(input.dataset.field)) inputsByKey.set(input.dataset.field, []);
    inputsByKey.get(input.dataset.field).push(input);
  });
  for (const field of schema) {
    const inputs = inputsByKey.get(field.key) ?? [];
    if (inputs.length === 0) continue;
    if (field.type === 'boolean') {
      result[field.key] = inputs[0].checked;
    } else if (field.type === 'multiselect') {
      result[field.key] = inputs.filter((i) => i.checked).map((i) => i.value);
    } else if (field.type === 'number') {
      result[field.key] = inputs[0].value === '' ? undefined : Number(inputs[0].value);
    } else {
      result[field.key] = inputs[0].value;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run to verify the unit tests pass**

Run: `node --test tests/unit/formFields.test.js`
Expected: PASS

- [ ] **Step 5: Update `frontend/account.html`**

Replace the import block:

```javascript
      import {
        escapeHtml,
        renderField,
        collectFieldValues,
        attachLiveValidation,
        attachBirthdateFormatter,
        STATUS_LABELS,
        renderEventOptions,
        renderAccountFieldInput,
        REGISTRATION_FIELD_LABELS,
        isOptOutYes,
        OPT_OUT_KEYS,
      } from "/js/formFields.js";
```

with:

```javascript
      import {
        escapeHtml,
        renderField,
        collectFieldValues,
        attachLiveValidation,
        attachBirthdateFormatter,
        STATUS_LABELS,
        renderEventOptions,
        renderAccountFieldInput,
        collectAccountFieldValues,
      } from "/js/formFields.js";
```

Near the top-level state (`let events = []; ...`), add `let registrationSchema = [];` and load it once (find where `loadEvents()`/`loadCharacters()` are called from the page's final startup `try {}` block and add a `registrationSchema = await api.get('/registration-schema');` call there, before anything that calls `renderOtFields`/`openEditOtDialog`).

Replace `renderOtFields`/`collectOtFields`:

```javascript
      function renderOtFields(values = {}) {
        otFieldsContainer.innerHTML = Object.entries(REGISTRATION_FIELD_LABELS)
          .map(([key, label]) =>
            renderAccountFieldInput(key, label, values[key], {
              idPrefix: "register-",
            }),
          )
          .join("");
        attachLiveValidation(otFieldsContainer);
      }

      function collectOtFields() {
        const result = {};
        otFieldsContainer.querySelectorAll("[data-field]").forEach((input) => {
          result[input.dataset.field] =
            input.type === "checkbox" ? (input.checked ? "Ja" : "Nein") : input.value;
        });
        return result;
      }
```

with:

```javascript
      function renderOtFields(values = {}) {
        otFieldsContainer.innerHTML = registrationSchema
          .map((field) => renderAccountFieldInput(field, values[field.key], { idPrefix: "register-" }))
          .join("");
        attachLiveValidation(otFieldsContainer);
      }

      function collectOtFields() {
        return collectAccountFieldValues(otFieldsContainer, registrationSchema);
      }
```

Replace `openEditOtDialog` and the `edit-ot-save` handler:

```javascript
      function openEditOtDialog(eventId) {
        const registration = currentRegistrations.find((r) => r.eventId === eventId);
        if (!registration) return;
        editingEventId = eventId;
        editOtFieldsContainer.innerHTML = Object.entries(REGISTRATION_FIELD_LABELS)
          .map(([key, label]) =>
            renderAccountFieldInput(key, label, registration[key], {
              idPrefix: "edit-",
            }),
          )
          .join("");
        attachLiveValidation(editOtFieldsContainer);
        editOtDialog.showModal();
      }
```

with:

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

and:

```javascript
      document.getElementById("edit-ot-save").addEventListener("click", async () => {
        const registration = currentRegistrations.find(
          (r) => r.eventId === editingEventId,
        );
        const payload = {};
        editOtFieldsContainer.querySelectorAll("[data-field]").forEach((input) => {
          const key = input.dataset.field;
          const originalValue = registration?.[key] ?? "";
          // Only send a field that actually changed -- a save that touched nothing
          // must not PUT .../ot-fields, since a successful call mails every event
          // orga/hilfs_orga plus every admin/moderator.
          const changed = OPT_OUT_KEYS.includes(key)
            ? isOptOutYes(originalValue) !== input.checked
            : originalValue !== input.value;
          if (!changed) return;
          payload[key] =
            input.type === "checkbox" ? (input.checked ? "Ja" : "Nein") : input.value;
        });
        registrationMessage.textContent = "";
```

with:

```javascript
      document.getElementById("edit-ot-save").addEventListener("click", async () => {
        const registration = currentRegistrations.find(
          (r) => r.eventId === editingEventId,
        );
        const collected = collectAccountFieldValues(editOtFieldsContainer, registrationSchema);
        const payload = {};
        for (const field of registrationSchema) {
          const originalValue = registration?.[field.key] ?? (field.type === "boolean" ? false : "");
          const newValue = collected[field.key];
          // Only send a field that actually changed -- a save that touched nothing
          // must not PUT .../ot-fields, since a successful call mails every event
          // orga/hilfs_orga plus every admin/moderator.
          if (field.type === "boolean" ? Boolean(originalValue) === Boolean(newValue) : originalValue === newValue) continue;
          payload[field.key] = newValue;
        }
        registrationMessage.textContent = "";
```

(The rest of that handler — the `Object.keys(payload).length === 0` early-return, the `api.put(...)` call, error handling — is unchanged.)

- [ ] **Step 6: Update `frontend/admin/members.html`**

Replace the import:

```javascript
    import { escapeHtml, attachBirthdateFormatter, attachLiveValidation, ACCOUNT_FIELD_LABELS, renderEventOptions, renderAccountFieldInput } from '/js/formFields.js';
```

with:

```javascript
    import { escapeHtml, attachBirthdateFormatter, attachLiveValidation, renderEventOptions, renderAccountFieldInput, collectAccountFieldValues } from '/js/formFields.js';
```

Replace `const ALL_FIELD_KEYS = Object.keys(ACCOUNT_FIELD_LABELS);` with a module-level mutable schema, populated on startup:

```javascript
    let accountSchema = [];
```

Replace `buildFieldInputs`:

```javascript
    function buildFieldInputs(container, values = {}) {
      container.innerHTML = myAccountFields
        .filter((key) => key !== 'group')
        .map((key) => renderAccountFieldInput(key, ACCOUNT_FIELD_LABELS[key] ?? key, values[key]))
        .join('');
      const birthdateInput = container.querySelector('[data-field="birthdate"]');
      if (birthdateInput) attachBirthdateFormatter(birthdateInput);
      attachLiveValidation(container);
    }
```

with:

```javascript
    function buildFieldInputs(container, values = {}) {
      container.innerHTML = accountSchema
        .filter((field) => myAccountFields.includes(field.key))
        .map((field) => renderAccountFieldInput(field, values[field.key]))
        .join('');
      attachLiveValidation(container);
    }
```

(`attachBirthdateFormatter` is dropped here — `birthdate` is now a native `type="date"` input via the schema's `date` type, which needs no typing-format helper.)

Replace `buildDetailFieldInputs`:

```javascript
    function buildDetailFieldInputs(container, values = {}) {
      const nameFieldsHtml = `
    <div class="firstName-container">
      <label for="field-firstName">Vorname</label>
      <input id="field-firstName" data-field="firstName" type="text" value="${escapeHtml(values.firstName ?? '')}">
    </div>
    <div class="lastName-container">
      <label for="field-lastName">Nachname</label>
      <input id="field-lastName" data-field="lastName" type="text" value="${escapeHtml(values.lastName ?? '')}">
    </div>
    <div class="nickname-container">
      <label for="field-nickname">Rufname</label>
      <input id="field-nickname" data-field="nickname" type="text" value="${escapeHtml(values.nickname ?? '')}">
    </div>
  `;
      container.innerHTML = nameFieldsHtml + ALL_FIELD_KEYS.map((key) => {
        const label = ACCOUNT_FIELD_LABELS[key] ?? key;
        if (myAccountFields.includes(key)) {
          const sealedBadge = ' <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span></span>';
          return renderAccountFieldInput(key, label, values[key], { sealedBadge });
        }
        return `<label>${escapeHtml(label)}</label><p>${escapeHtml(values[key] ?? '–')}</p>`;
      }).join('');
      const birthdateInput = container.querySelector('[data-field="birthdate"]');
      if (birthdateInput) attachBirthdateFormatter(birthdateInput);
      attachLiveValidation(container);
    }
```

with:

```javascript
    function buildDetailFieldInputs(container, values = {}) {
      const nameFieldsHtml = `
    <div class="firstName-container">
      <label for="field-firstName">Vorname</label>
      <input id="field-firstName" data-field="firstName" type="text" value="${escapeHtml(values.firstName ?? '')}">
    </div>
    <div class="lastName-container">
      <label for="field-lastName">Nachname</label>
      <input id="field-lastName" data-field="lastName" type="text" value="${escapeHtml(values.lastName ?? '')}">
    </div>
    <div class="nickname-container">
      <label for="field-nickname">Rufname</label>
      <input id="field-nickname" data-field="nickname" type="text" value="${escapeHtml(values.nickname ?? '')}">
    </div>
  `;
      container.innerHTML = nameFieldsHtml + accountSchema.map((field) => {
        const label = field.label ?? field.key;
        if (myAccountFields.includes(field.key)) {
          const sealedBadge = ' <span class="sealed" title="Dieses Feld ist verschlüsselt gespeichert"><span class="material-symbols-outlined" aria-hidden="true">lock</span></span>';
          return renderAccountFieldInput(field, values[field.key], { sealedBadge });
        }
        return `<label>${escapeHtml(label)}</label><p>${escapeHtml(values[field.key] ?? '–')}</p>`;
      }).join('');
      attachLiveValidation(container);
    }
```

Replace the `detail-save` handler's payload collection:

```javascript
      detailFields.querySelectorAll('[data-field]').forEach((input) => {
        payload[input.dataset.field] = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
      });
```

with:

```javascript
      Object.assign(payload, collectAccountFieldValues(detailFields, [
        { key: 'firstName', type: 'text' }, { key: 'lastName', type: 'text' }, { key: 'nickname', type: 'text' },
        ...accountSchema,
      ]));
```

Replace the invite form submit handler's payload collection:

```javascript
      inviteFields.querySelectorAll('[data-field]').forEach((input) => {
        payload[input.dataset.field] = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
      });
```

with:

```javascript
      Object.assign(payload, collectAccountFieldValues(inviteFields, accountSchema));
```

Finally, in the trailing startup `try { ... }` block, load the schema before the first call to `buildFieldInputs`:

```javascript
      const account = await api.get('/account');
      document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
      document.getElementById('sidebar-user-info').innerHTML = renderSidebarUser(account);
      myAccountFields = account.accountFields ?? [];
      myUserId = account.id;
      buildFieldInputs(inviteFields);
```

becomes:

```javascript
      const account = await api.get('/account');
      document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
      document.getElementById('sidebar-user-info').innerHTML = renderSidebarUser(account);
      myAccountFields = account.accountFields ?? [];
      myUserId = account.id;
      accountSchema = await api.get('/account-schema');
      buildFieldInputs(inviteFields);
```

- [ ] **Step 7: Update `frontend/admin/checkin.html`**

Replace the import:

```javascript
import { escapeHtml, formatFieldValue, ACCOUNT_FIELD_LABELS, REGISTRATION_FIELD_LABELS, STATUS_LABELS, renderEventOptions, renderAccountFieldInput, renderField, collectFieldValues, isOptOutYes, OPT_OUT_KEYS } from '/js/formFields.js';
```

with:

```javascript
import { escapeHtml, formatFieldValue, STATUS_LABELS, renderEventOptions, renderAccountFieldInput, collectAccountFieldValues, renderField, collectFieldValues } from '/js/formFields.js';
```

Replace `const OT_FIELD_LABELS = { ...ACCOUNT_FIELD_LABELS, ...REGISTRATION_FIELD_LABELS };` and the two schema state variables it sits near with:

```javascript
let accountSchema = [];
let registrationSchema = [];
```

(remove the old `const OT_FIELD_LABELS = ...` line entirely.)

`renderColumnCheckboxes` currently builds the OT-column checkboxes off `OT_FIELD_LABELS`:

```javascript
  const otKeys = Object.keys(OT_FIELD_LABELS).filter((key) => myAccountFields.includes(key));
  otColumnCheckboxes.innerHTML = otKeys.map((key) => `
    <label><input type="checkbox" data-ot-column="${escapeHtml(key)}" ${selectedColumns.ot.includes(key) ? 'checked' : ''}> ${escapeHtml(OT_FIELD_LABELS[key])}</label>
  `).join('');
```

Replace with:

```javascript
  const otFieldsByKey = new Map([...accountSchema, ...registrationSchema].map((f) => [f.key, f]));
  const otKeys = [...otFieldsByKey.keys()].filter((key) => myAccountFields.includes(key));
  otColumnCheckboxes.innerHTML = otKeys.map((key) => `
    <label><input type="checkbox" data-ot-column="${escapeHtml(key)}" ${selectedColumns.ot.includes(key) ? 'checked' : ''}> ${escapeHtml(otFieldsByKey.get(key).label ?? key)}</label>
  `).join('');
```

`renderTableHead`'s `otLabels` line:

```javascript
  const otLabels = selectedColumns.ot.map((key) => OT_FIELD_LABELS[key] ?? key);
```

becomes:

```javascript
  const otFieldsByKey = new Map([...accountSchema, ...registrationSchema].map((f) => [f.key, f]));
  const otLabels = selectedColumns.ot.map((key) => otFieldsByKey.get(key)?.label ?? key);
```

(Since `renderColumnCheckboxes` already builds an identical local `otFieldsByKey`, and both functions run in the same module scope, hoist this map to one shared module-level `let otFieldsByKey = new Map();` set once when the schemas load, instead of rebuilding it in both functions — replace the two local `const otFieldsByKey = ...` lines above with a single top-level declaration next to `let accountSchema = [];` / `let registrationSchema = [];`:

```javascript
let accountSchema = [];
let registrationSchema = [];
let otFieldsByKey = new Map();
```

and set it once, right after the schemas are fetched (see the final startup block change below): `otFieldsByKey = new Map([...accountSchema, ...registrationSchema].map((f) => [f.key, f]));`. Then both `renderColumnCheckboxes` and `renderTableHead` just reference the shared `otFieldsByKey` directly, with no local re-declaration.)

Replace `openEditDialog`'s OT-field rendering:

```javascript
  const otKeys = canManageMembers ? Object.keys(p.otFields ?? {}) : [];
  editOtFields.innerHTML = otKeys.length > 0
    ? `<h3>Weitere Felder</h3>` + otKeys.map((key) => renderAccountFieldInput(key, OT_FIELD_LABELS[key] ?? key, p.otFields[key])).join('')
    : '';
```

with:

```javascript
  const otKeys = canManageMembers ? Object.keys(p.otFields ?? {}) : [];
  const editableOtFields = otKeys.map((key) => otFieldsByKey.get(key)).filter(Boolean);
  editOtFields.innerHTML = editableOtFields.length > 0
    ? `<h3>Weitere Felder</h3>` + editableOtFields.map((field) => renderAccountFieldInput(field, p.otFields[field.key])).join('')
    : '';
```

Replace the `edit-save` handler's payload split:

```javascript
  const original = participantsById.get(editingUserId)?.otFields ?? {};
  const accountPayload = {};
  const registrationPayload = {};
  editOtFields.querySelectorAll('[data-field]').forEach((input) => {
    const key = input.dataset.field;
    const originalValue = original[key] ?? '';
    // Only send a field whose value actually changed -- an edit-save that
    // touched nothing OT-related (e.g. only a character field) must not
    // trigger PATCH /members or PUT .../ot-fields, since either one mails
    // every event orga/hilfs_orga plus every admin/moderator on success.
    const changed = OPT_OUT_KEYS.includes(key) ? isOptOutYes(originalValue) !== input.checked : originalValue !== input.value;
    if (!changed) return;
    const value = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
    if (key in ACCOUNT_FIELD_LABELS) accountPayload[key] = value;
    else registrationPayload[key] = value;
  });
```

with:

```javascript
  const original = participantsById.get(editingUserId)?.otFields ?? {};
  const editedFields = [...editOtFields.querySelectorAll('[data-field]')]
    .map((input) => otFieldsByKey.get(input.dataset.field))
    .filter((field, index, arr) => field && arr.findIndex((f) => f.key === field.key) === index);
  const collected = collectAccountFieldValues(editOtFields, editedFields);
  const accountAccountFieldKeys = new Set(accountSchema.map((f) => f.key));
  const accountPayload = {};
  const registrationPayload = {};
  for (const field of editedFields) {
    const originalValue = original[field.key] ?? (field.type === 'boolean' ? false : '');
    const newValue = collected[field.key];
    // Only send a field whose value actually changed -- an edit-save that
    // touched nothing OT-related (e.g. only a character field) must not
    // trigger PATCH /members or PUT .../ot-fields, since either one mails
    // every event orga/hilfs_orga plus every admin/moderator on success.
    if (field.type === 'boolean' ? Boolean(originalValue) === Boolean(newValue) : originalValue === newValue) continue;
    if (accountAccountFieldKeys.has(field.key)) accountPayload[field.key] = newValue;
    else registrationPayload[field.key] = newValue;
  }
```

Finally, in the trailing startup `try { ... }` block, replace:

```javascript
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  document.getElementById('sidebar-user-info').innerHTML = renderSidebarUser(account);
  canOverride = !!account.canOverrideCheckinStatus;
  canManageMembers = (account.menus ?? []).includes('mitglieder');
  myAccountFields = account.accountFields ?? [];
  currentHotkeys = { ...DEFAULT_HOTKEYS, ...(account.hotkeys ?? {}) };
  currentSchema = await api.get('/sc-schema');
  events = await api.get('/events');
```

with:

```javascript
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  document.getElementById('sidebar-user-info').innerHTML = renderSidebarUser(account);
  canOverride = !!account.canOverrideCheckinStatus;
  canManageMembers = (account.menus ?? []).includes('mitglieder');
  myAccountFields = account.accountFields ?? [];
  currentHotkeys = { ...DEFAULT_HOTKEYS, ...(account.hotkeys ?? {}) };
  currentSchema = await api.get('/sc-schema');
  [accountSchema, registrationSchema] = await Promise.all([api.get('/account-schema'), api.get('/registration-schema')]);
  otFieldsByKey = new Map([...accountSchema, ...registrationSchema].map((f) => [f.key, f]));
  events = await api.get('/events');
```

(Everything after `events = await api.get('/events');` in that block — `eventSelect.innerHTML = ...`, the `if (events.length > 0)` branch, the `catch` block — is unchanged.)

- [ ] **Step 8: Grep for any remaining reference to the removed exports**

Run:

```bash
grep -rn "OPT_OUT_KEYS\|isOptOutYes\|ACCOUNT_FIELD_LABELS\|REGISTRATION_FIELD_LABELS\|attachBirthdateFormatter" frontend
```

Every hit must be one of: `frontend/js/formFields.js`'s own definition of `attachBirthdateFormatter` (kept — still a generically useful helper even though no call site uses it after this task; if truly unused after this task, delete it and its own unit test coverage instead of leaving dead code) or a genuinely intentional remaining usage. Fix or delete anything else.

- [ ] **Step 9: Manual verification**

Using `docker compose -f docker-compose.dev.yml up`:
1. As a `mitglied` user on `/account.html`: register for an event, confirm the OT fields render with correct types (checkboxes for opt-outs, native date-like text as before for other text fields), submit, reload, confirm values persisted and re-render correctly, including editing an existing registration's OT fields via the edit dialog.
2. As `admin` on `/admin/members.html`: open the invite dialog, confirm account fields render correctly; open an existing member's detail dialog, confirm sealed-badge fields still show the lock icon, edit and save.
3. As `admin`/`orga` on `/admin/checkin.html`: open a participant's edit dialog, confirm OT fields (from both the account and registration schemas) render and save correctly, split correctly between `PATCH /members/:id` and `PUT .../ot-fields`.

- [ ] **Step 10: Commit**

```bash
git add frontend/js/formFields.js frontend/account.html frontend/admin/members.html frontend/admin/checkin.html tests/unit/formFields.test.js
git commit -m "feat: render OT fields generically from the admin-editable schemas"
```

---

## Task 8: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass. If anything fails, it is almost certainly a stale reference to one of the removed exports/columns (`ACCOUNT_FIELD_LABELS`, `REGISTRATION_FIELD_LABELS`, `OPT_OUT_KEYS`, `isOptOutYes`, `ACCOUNT_FIELD_KEYS`, `REGISTRATION_FIELD_KEYS`, `ENCRYPTED_ACCOUNT_FIELD_COLUMNS`, `ENCRYPTED_REGISTRATION_FIELD_COLUMNS`, or a dropped `*_enc` column) missed by an earlier task's grep step — find it with the same grep pattern and fix it in place.

- [ ] **Step 2: Final repo-wide grep sweep**

Run:

```bash
grep -rn "ACCOUNT_FIELD_LABELS\|REGISTRATION_FIELD_LABELS\|OPT_OUT_KEYS\|isOptOutYes\|ACCOUNT_FIELD_KEYS\|REGISTRATION_FIELD_KEYS\|ENCRYPTED_ACCOUNT_FIELD_COLUMNS\|ENCRYPTED_REGISTRATION_FIELD_COLUMNS\|address_enc\|birthdate_enc\|con_tage_enc" backend frontend tests db
```

Expected: zero hits.

- [ ] **Step 3: Manual browser regression check**

Using `docker compose -f docker-compose.dev.yml up` (fresh volume, so migrations + backfill scripts run from scratch): confirm registration, login, account editing, member management, group editing, and check-in all still work end to end for a `mitglied` and an `admin` user, covering both the new `/admin/character-schema.html` Konto/Anmeldung tabs and the existing SC/GSC/NSC tabs.

- [ ] **Step 4: Commit** (only if Steps 1-3 required fixes; otherwise nothing to commit)

```bash
git add -A
git commit -m "fix: close remaining gaps found in the OT-Felder admin-schema full regression pass"
```
