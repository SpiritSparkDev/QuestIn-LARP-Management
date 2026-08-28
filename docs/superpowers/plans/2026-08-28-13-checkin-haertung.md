# Check-In-Härtung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Admin/Orga/SL set a participant's check-in status directly to any value (not just the next step in the linear chain), with a confirmation dialog when the change is a rollback, so front-desk staff can correct human error without needing raw DB access.

**Architecture:** A new per-group boolean permission (`groups.can_override_checkin_status`), data-driven like every other group permission in this app — not hardcoded to specific group keys. A new `PUT /events/:id/checkin/:userId` endpoint sets a registration's status directly (bypassing the existing linear `applyTransition` chain used by the normal check-in/check-out flow, which stays unchanged). The frontend adds a status-select per participant row, visible only to permitted users, confirming before any backward change.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step.

**Spec:** `docs/superpowers/specs/2026-08-28-charakterklassen-und-hardening-design.md` (Abschnitt 3 "Status-Override mit Bestätigung (Check-In)")

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step — standing rule for every plan in this sequence.
- `groups.can_override_checkin_status` must default to `true` for `admin`/`orga`/`sl` and `false` for the other 5 groups, both in the migration's retroactive grant AND in `db/groupDefaults.js`'s fresh-install defaults — the two MUST agree for all 8 groups. **`db/seedGroups.js`'s INSERT statement must also include this column** — a prior plan in this sequence shipped a real bug specifically because a new group-permission column was added to `groupDefaults.js` and the migration but NOT to `seedGroups.js`'s INSERT, so a brand-new database's first seed silently fell back to the column's SQL default for every group. Do not repeat that mistake.
- The permission must be a per-group data-driven boolean (`groups.can_override_checkin_status`), never a hardcoded `user.group.key === 'admin' || ... === 'orga' || ... === 'sl'` check in application code.
- The normal check-in/check-out flow (`POST /events/:id/checkin`, `POST /events/:id/checkout`, `applyTransition`, the existing Check-In/Check-Out buttons) must keep working exactly as before, unchanged — the override is an ADDITIONAL capability, not a replacement.
- A confirmation dialog (`confirm('Bist du sicher?')` or similar wording) must appear before any status change that is NOT a forward step in the `registered → checked_in → checked_out` order. A forward-or-same change proceeds without confirmation.
- Every existing test must still pass; verify with each task's specified scope before the final full-suite gate.
- Verify visually via Claude Browser tools for every page touched.

---

### Task 1: `groups.can_override_checkin_status` — Datenmodell + Gruppen-Verwaltung

**Files:**
- Create: `db/migrations/013_checkin_status_override.sql`
- Modify: `db/groupDefaults.js`
- Modify: `db/seedGroups.js`
- Modify: `backend/groups/repository.js`
- Modify: `backend/groups/routes.js`
- Modify: `backend/middleware/authenticate.js`
- Modify: `backend/accounts/repository.js`
- Modify: `frontend/admin/groups.html`
- Modify: `tests/integration/groups.test.js`
- Modify: `tests/integration/schema-users.test.js`
- Modify: `tests/integration/accounts.test.js`

**Interfaces:**
- Produces: `user.group.canOverrideCheckinStatus` (boolean) on the `user` object every `requireAuth`-wrapped handler receives — consumed by Task 2's new `PUT /events/:id/checkin/:userId` permission check. Also produces top-level `canOverrideCheckinStatus` on the `GET /account` response body — consumed by Task 3's frontend.

- [ ] **Step 1: Write the migration**

Create `db/migrations/013_checkin_status_override.sql`:

```sql
ALTER TABLE groups ADD COLUMN can_override_checkin_status boolean NOT NULL DEFAULT false;

UPDATE groups SET can_override_checkin_status = true
WHERE key IN ('admin', 'orga', 'sl') AND can_override_checkin_status = false;
```

(Same "retroactive grant" pattern as `009_pronomen_field.sql`/`010_group_character_classes.sql` — a `db/groupDefaults.js` edit alone only affects a brand-new database's first seed run, `db/seedGroups.js` uses `ON CONFLICT (key) DO NOTHING`.)

- [ ] **Step 2: Update `db/groupDefaults.js`**

Add `canOverrideCheckinStatus` to every one of the 8 entries:

```javascript
export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen', 'group'],
    canEditCharacters: true, characterClasses: ['sc'], canOverrideCheckinStatus: true, isProtected: true,
  },
  {
    key: 'orga', name: 'Orga',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen'],
    canEditCharacters: true, characterClasses: ['sc'], canOverrideCheckinStatus: true, isProtected: false,
  },
  {
    key: 'plot_orga', name: 'Plot-Orga',
    visibleMenus: ['konto', 'charaktere', 'events', 'checkin'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], canOverrideCheckinStatus: false, isProtected: false,
  },
  {
    key: 'sl', name: 'SL',
    visibleMenus: ['konto', 'charaktere', 'checkin'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], canOverrideCheckinStatus: true, isProtected: false,
  },
  {
    key: 'hilfs_sl', name: 'Hilfs-SL',
    visibleMenus: ['konto', 'charaktere', 'checkin'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], canOverrideCheckinStatus: false, isProtected: false,
  },
  {
    key: 'nsc', name: 'NSC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, characterClasses: ['nsc'], canOverrideCheckinStatus: false, isProtected: false,
  },
  {
    key: 'gsc', name: 'GSC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], canOverrideCheckinStatus: false, isProtected: false,
  },
  {
    key: 'sc', name: 'SC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, characterClasses: ['sc'], canOverrideCheckinStatus: false, isProtected: false,
  },
];
```

- [ ] **Step 3: Update `db/seedGroups.js`'s INSERT statement**

This step is critical — a prior plan in this sequence shipped a real bug by forgetting exactly this step for a different column. Find the `INSERT INTO groups (...)` statement inside `seedGroups()` and add `can_override_checkin_status` to both the column list and the values array:

```javascript
export async function seedGroups() {
  for (const group of GROUP_DEFAULTS) {
    await query(
      `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, character_classes, can_override_checkin_status, is_protected)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO NOTHING`,
      [
        group.key,
        group.name,
        JSON.stringify(group.visibleMenus),
        JSON.stringify(group.accountFields),
        group.canEditCharacters,
        JSON.stringify(group.characterClasses),
        group.canOverrideCheckinStatus,
        group.isProtected,
      ]
    );
  }
  // ... rest of the function (the role backfill block) is unchanged, leave it exactly as-is
```

(Only the `INSERT` statement's column list, placeholder list, and values array change — the `$7`/`$8` placeholders shift by one from the current `$6`/`$7` for `character_classes`/`is_protected`. Everything below that `INSERT` call, including the `role`→`group_id` backfill block, stays untouched.)

- [ ] **Step 4: Extend `backend/groups/repository.js`**

Replace the entire file:

```javascript
import { query } from '../db.js';

const SELECT_COLUMNS = 'id, key, name, visible_menus, account_fields, can_edit_characters, character_classes, can_override_checkin_status, is_protected';

export async function listGroups() {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups ORDER BY name`);
  return rows;
}

export async function getGroup(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM groups WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createGroup({ key, name, visibleMenus, accountFields, canEditCharacters, characterClasses, canOverrideCheckinStatus }) {
  const { rows } = await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, character_classes, can_override_checkin_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [key, name, JSON.stringify(visibleMenus ?? []), JSON.stringify(accountFields ?? []), !!canEditCharacters, JSON.stringify(characterClasses ?? []), !!canOverrideCheckinStatus]
  );
  return rows[0];
}

export async function updateGroup(id, { name, visibleMenus, accountFields, canEditCharacters, characterClasses, canOverrideCheckinStatus }) {
  const { rows } = await query(
    `UPDATE groups SET
       name = COALESCE($2, name),
       visible_menus = COALESCE($3, visible_menus),
       account_fields = COALESCE($4, account_fields),
       can_edit_characters = COALESCE($5, can_edit_characters),
       character_classes = COALESCE($6, character_classes),
       can_override_checkin_status = COALESCE($7, can_override_checkin_status)
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      name ?? null,
      visibleMenus !== undefined ? JSON.stringify(visibleMenus) : null,
      accountFields !== undefined ? JSON.stringify(accountFields) : null,
      canEditCharacters !== undefined ? canEditCharacters : null,
      characterClasses !== undefined ? JSON.stringify(characterClasses) : null,
      canOverrideCheckinStatus !== undefined ? canOverrideCheckinStatus : null,
    ]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 5: Extend `backend/groups/routes.js`**

`canOverrideCheckinStatus` is a plain boolean (like `canEditCharacters`), so it needs no array-shape validator — just destructure and pass through in both `POST /groups` and `PUT /groups/:id`:

In the `POST /groups` handler, change:
```javascript
  const { key, name, visibleMenus, accountFields, canEditCharacters, characterClasses } = body;
```
to:
```javascript
  const { key, name, visibleMenus, accountFields, canEditCharacters, characterClasses, canOverrideCheckinStatus } = body;
```
and change the `createGroup` call to:
```javascript
    const group = await createGroup({ key, name, visibleMenus, accountFields, canEditCharacters, characterClasses, canOverrideCheckinStatus });
```

In the `PUT /groups/:id` handler, change:
```javascript
  const { name, visibleMenus, accountFields, canEditCharacters, characterClasses } = body;
```
to:
```javascript
  const { name, visibleMenus, accountFields, canEditCharacters, characterClasses, canOverrideCheckinStatus } = body;
```
and change the `updateGroup` call to:
```javascript
  const group = await updateGroup(params.id, { name, visibleMenus, accountFields, canEditCharacters, characterClasses, canOverrideCheckinStatus });
```

(No new validation function needed — everything else in both handlers stays exactly as-is.)

- [ ] **Step 6: Add `canOverrideCheckinStatus` to the auth context**

In `backend/middleware/authenticate.js`, add `groups.can_override_checkin_status` to the SELECT and `canOverrideCheckinStatus` to the returned `user.group` object:

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
              groups.visible_menus, groups.account_fields, groups.can_edit_characters,
              groups.character_classes, groups.can_override_checkin_status
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
        canOverrideCheckinStatus: row.can_override_checkin_status,
      },
    };

    return handler({ ...ctx, user });
  };
}
```

- [ ] **Step 7: Add `canOverrideCheckinStatus` to `GET /account`'s response**

In `backend/accounts/repository.js`, add `groups.can_override_checkin_status` to `SELECT_COLUMNS` and `canOverrideCheckinStatus: row.can_override_checkin_status` to `decryptAccount`'s return object:

Find the `decryptAccount` function and add the new field (after `characterClasses`, before `emailVerified`):
```javascript
    characterClasses: row.character_classes,
    canOverrideCheckinStatus: row.can_override_checkin_status,
    emailVerified: row.email_verified,
```

Find `SELECT_COLUMNS` and add `groups.can_override_checkin_status`:
```javascript
const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc, users.pronomen_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields, groups.character_classes, groups.can_override_checkin_status
`;
```

(Read the file's actual current content first — Task 4 of the previous plan in this sequence already settled this file's shape; only add the two lines above, don't change anything else.)

- [ ] **Step 8: Add the checkbox to `frontend/admin/groups.html`**

Add a new checkbox group after the existing `#class-checkboxes` block (before the `can-edit-characters` checkbox block):

```html
        <div class="checkbox-group">
          <label><input type="checkbox" id="can-override-checkin-status"> Darf Check-In-Status frei setzen (Admin/Orga/SL-Funktion)</label>
        </div>
```

In the script, add `canOverrideCheckinStatus: document.getElementById('can-override-checkin-status').checked` to the submit handler's `payload` object, and restore it in `startEdit`:

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
  document.getElementById('can-override-checkin-status').checked = group.can_override_checkin_status;
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
    canOverrideCheckinStatus: document.getElementById('can-override-checkin-status').checked,
  };
```

(This checkbox is unchecked by default for NEW groups — unlike Task 2's `sc` character-class checkbox from the previous plan, an unchecked default here is CORRECT, since `false` is the safe default for a status-override permission: a new group should not silently get override power. Do not add a `checked` attribute to this checkbox.)

- [ ] **Step 9: Write the failing tests**

Add to `tests/integration/groups.test.js` (read the current file first to match its exact `makeUserAndSession`/cleanup conventions, then append):

```javascript
test('POST /groups accepts and returns canOverrideCheckinStatus; PUT /groups/:id updates it', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ key: `test_override_${crypto.randomUUID().slice(0, 8)}`, name: 'Override Test', canOverrideCheckinStatus: true }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.can_override_checkin_status, true);

    const updateRes = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ canOverrideCheckinStatus: false }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal((await updateRes.json()).can_override_checkin_status, false);

    await query('DELETE FROM groups WHERE id = $1', [created.id]);
  } finally {
    server.close();
  }
});
```

Add to `tests/integration/schema-users.test.js` (append):

```javascript
test('admin, orga, and sl groups have can_override_checkin_status=true after migration; others false', async () => {
  const { rows } = await query('SELECT key, can_override_checkin_status FROM groups');
  for (const row of rows) {
    const expected = ['admin', 'orga', 'sl'].includes(row.key);
    assert.equal(row.can_override_checkin_status, expected, `${row.key} should have can_override_checkin_status=${expected}`);
  }
});
```

Add to `tests/integration/accounts.test.js` (append, following the file's existing `registerLoginAndGetCookie` helper pattern):

```javascript
test('GET /account includes canOverrideCheckinStatus from the caller\'s group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await registerLoginAndGetCookie(port);
    const res = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    const body = await res.json();
    assert.equal(body.canOverrideCheckinStatus, false);
  } finally {
    server.close();
  }
});
```

(A fresh self-registered user lands in the default `sc` group, which has `canOverrideCheckinStatus: false` — this test confirms the field is present and correctly `false` for a non-privileged group.)

- [ ] **Step 10: Run the tests**

Run: `node --test tests/integration/groups.test.js tests/integration/schema-users.test.js tests/integration/accounts.test.js`
Expected: all PASS (existing + new).

- [ ] **Step 11: Verify visually**

Using Claude Browser tools against the running dev stack: log in as `admin@pakyrion.local`/`0000`, go to `/admin/groups.html`, confirm the new checkbox appears, confirm `orga`'s row already shows it checked when editing (proving the data migration applied), toggle+save+reload to confirm persistence, confirm a brand-new group's checkbox is unchecked by default.

- [ ] **Step 12: Commit**

```bash
git add db/migrations/013_checkin_status_override.sql db/groupDefaults.js db/seedGroups.js backend/groups/repository.js backend/groups/routes.js backend/middleware/authenticate.js backend/accounts/repository.js frontend/admin/groups.html tests/integration/groups.test.js tests/integration/schema-users.test.js tests/integration/accounts.test.js
git commit -m "feat: add groups.can_override_checkin_status as a per-group, data-driven permission"
```

---

### Task 2: Status-Override-Endpunkt

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Modify: `tests/integration/checkin.test.js`

**Interfaces:**
- Consumes: `user.group.canOverrideCheckinStatus` (Task 1) for the new endpoint's permission check.
- Produces: `export async function setStatus(eventId, userId, status)` from `backend/registrations/repository.js` — returns the updated registration row (`{user_id, event_id, status, checked_in_at, checked_out_at}`), or throws an error with `code: 'REGISTRATION_NOT_FOUND'` if no matching registration exists. `PUT /events/:id/checkin/:userId` (new route) — consumed by Task 3's frontend.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/checkin.test.js` (append, before `test.after`):

```javascript
test('a user without canOverrideCheckinStatus cannot use the override endpoint', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const helper = await makeUserAndSession('sl');
  const stranger = await makeUserAndSession('sc');
  const eventId = await makeEvent();
  await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [stranger.userId, eventId]);

  const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${stranger.userId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
    body: JSON.stringify({ status: 'checked_in' }),
  });
  assert.equal(res.status, 403);

  server.close();
});

test('a user with canOverrideCheckinStatus can set a status directly, including a backward transition', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const attendee = await makeUserAndSession('sc');
  const eventId = await makeEvent();
  await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

  const toCheckedOut = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ status: 'checked_out' }),
  });
  assert.equal(toCheckedOut.status, 200);
  const checkedOutBody = await toCheckedOut.json();
  assert.equal(checkedOutBody.status, 'checked_out');
  assert.ok(checkedOutBody.checked_in_at, 'skipping straight to checked_out should also set checked_in_at');
  assert.ok(checkedOutBody.checked_out_at);

  const backToRegistered = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ status: 'registered' }),
  });
  assert.equal(backToRegistered.status, 200);
  const registeredBody = await backToRegistered.json();
  assert.equal(registeredBody.status, 'registered');
  assert.equal(registeredBody.checked_in_at, null);
  assert.equal(registeredBody.checked_out_at, null);

  server.close();
});

test('the override endpoint rejects an invalid status value', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const attendee = await makeUserAndSession('sc');
  const eventId = await makeEvent();
  await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

  const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ status: 'nonsense' }),
  });
  assert.equal(res.status, 400);

  server.close();
});

test('the override endpoint returns 404 for a user with no registration for the event', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const stranger = await makeUserAndSession('sc');
  const eventId = await makeEvent();

  const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${stranger.userId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ status: 'checked_in' }),
  });
  assert.equal(res.status, 404);

  server.close();
});

test('the normal checkin/checkout flow still works unchanged alongside the override endpoint', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const helper = await makeUserAndSession('sl');
  const attendee = await makeUserAndSession('sc');
  const eventId = await makeEvent();
  await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

  const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
    body: JSON.stringify({ userId: attendee.userId }),
  });
  assert.equal(checkinRes.status, 200);
  assert.equal((await checkinRes.json()).status, 'checked_in');

  server.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/integration/checkin.test.js`
Expected: FAIL — `PUT /events/:id/checkin/:userId` doesn't exist yet (404/connection errors on the new endpoint's tests); the last test (normal flow unchanged) should already PASS since it doesn't touch new code.

- [ ] **Step 3: Add `setStatus` to `backend/registrations/repository.js`**

Add this new export after the existing `checkOut` function (at the end of the file):

```javascript
export async function setStatus(eventId, userId, status) {
  const { rows } = await query(
    `UPDATE registrations SET
       status = $3,
       checked_in_at = CASE
         WHEN $3 = 'registered' THEN NULL
         WHEN checked_in_at IS NULL THEN now()
         ELSE checked_in_at
       END,
       checked_out_at = CASE
         WHEN $3 IN ('registered', 'checked_in') THEN NULL
         WHEN checked_out_at IS NULL THEN now()
         ELSE checked_out_at
       END
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, checked_in_at, checked_out_at`,
    [eventId, userId, status]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}
```

(This bypasses `applyTransition`'s linear-chain restriction on purpose — overriding IS the point. Setting `status` to `'registered'` clears both timestamps; setting to `'checked_in'` sets `checked_in_at` if it isn't already set and clears `checked_out_at`; setting to `'checked_out'` sets both timestamps if missing, so skipping straight from `registered` to `checked_out` still produces a sensible `checked_in_at`.)

- [ ] **Step 4: Add the route to `backend/registrations/routes.js`**

Add the import and the new route. Change the import line:

```javascript
import {
  registerForEvent,
  unregisterFromEvent,
  listParticipantsForEvent,
  listRegistrationsForUser,
  checkIn,
  checkOut,
  setStatus,
} from './repository.js';
```

Add the new route after the existing `checkout` route (at the end of the file):

```javascript
const VALID_STATUSES = ['registered', 'checked_in', 'checked_out'];

router.put('/events/:id/checkin/:userId', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
  if (!user.group.canOverrideCheckinStatus) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!VALID_STATUSES.includes(body.status)) {
    return { status: 400, body: { error: `status must be one of: ${VALID_STATUSES.join(', ')}` } };
  }
  try {
    const registration = await setStatus(params.id, params.userId, body.status);
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    throw err;
  }
})));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/integration/checkin.test.js`
Expected: all PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js tests/integration/checkin.test.js
git commit -m "feat: add PUT /events/:id/checkin/:userId to set a registration's status directly"
```

---

### Task 3: Frontend — Status-Override-UI mit Bestätigung; volle Testsuite

**Files:**
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `account.canOverrideCheckinStatus` (Task 1), `PUT /events/:id/checkin/:userId` (Task 2).

- [ ] **Step 1: Add the override select column**

Add `<th>Override</th>` to the table header, after the existing empty `<th></th>` (the one holding the Check-In/Check-Out buttons):

```html
        <thead><tr><th>Name</th><th>Charaktere</th><th>Status</th><th></th><th>Override</th></tr></thead>
```

- [ ] **Step 2: Add module-level state and the render function**

Add a module-level variable near the other `let`/`const` declarations at the top of the script:

```javascript
let canOverride = false;
const STATUS_ORDER = ['registered', 'checked_in', 'checked_out'];
```

Add a new function, near `applySearchFilter`:

```javascript
function renderOverrideCell(p) {
  if (!canOverride) return '';
  const options = STATUS_ORDER.map((s) => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${escapeHtml(STATUS_LABELS[s])}</option>`).join('');
  return `<select data-override="${p.userId}" data-prev-status="${p.status}">${options}</select>`;
}
```

- [ ] **Step 3: Add the column to the row template and wire the change handler**

In `loadParticipants`, add the new `<td>` to the row template (after the existing button `<td>`):

```javascript
async function loadParticipants(eventId) {
  const participants = await api.get(`/events/${eventId}/participants`);
  listBody.innerHTML = participants.map((p) => `<tr>
    <td>${escapeHtml(p.name)}</td>
    <td>${escapeHtml(p.characters.map((c) => c.name).join(', '))}</td>
    <td><span class="status-pill status-${escapeHtml(p.status)}">${escapeHtml(STATUS_LABELS[p.status] ?? p.status)}</span></td>
    <td>
      <button type="button" class="btn" data-checkin="${p.userId}" ${p.status !== 'registered' ? 'disabled' : ''}>Check-In</button>
      <button type="button" class="btn btn-ghost" data-checkout="${p.userId}" ${p.status !== 'checked_in' ? 'disabled' : ''}>Check-Out</button>
    </td>
    <td>${renderOverrideCell(p)}</td>
  </tr>`).join('');

  statTotal.textContent = participants.length;
  statCheckedIn.textContent = participants.filter((p) => p.status === 'checked_in').length;

  listBody.querySelectorAll('[data-checkin]').forEach((button) => {
    button.addEventListener('click', () => transition(eventId, button.dataset.checkin, 'checkin'));
  });
  listBody.querySelectorAll('[data-checkout]').forEach((button) => {
    button.addEventListener('click', () => transition(eventId, button.dataset.checkout, 'checkout'));
  });
  listBody.querySelectorAll('[data-override]').forEach((select) => {
    select.addEventListener('change', () => overrideStatus(eventId, select.dataset.override, select.value, select.dataset.prevStatus));
  });

  applySearchFilter();
}
```

- [ ] **Step 4: Add the `overrideStatus` function**

Add this function after the existing `transition` function:

```javascript
async function overrideStatus(eventId, userId, newStatus, previousStatus) {
  const newIndex = STATUS_ORDER.indexOf(newStatus);
  const previousIndex = STATUS_ORDER.indexOf(previousStatus);
  if (newIndex < previousIndex && !confirm('Bist du sicher? Dies setzt den Status zurück.')) {
    await loadParticipants(eventId);
    return;
  }
  message.textContent = '';
  message.className = '';
  try {
    await api.put(`/events/${eventId}/checkin/${userId}`, { status: newStatus });
    await loadParticipants(eventId);
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
    await loadParticipants(eventId);
  }
}
```

(A forward-or-equal change — `newIndex >= previousIndex` — skips the confirmation entirely. Reloading after a cancelled confirm resets the `<select>` back to the participant's real current status, since `renderOverrideCell` always renders `selected` on the actual `p.status`.)

- [ ] **Step 5: Set `canOverride` during page init**

In the final `try` block at the bottom of the script, set `canOverride` from the account before the first `loadParticipants` call:

```javascript
try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  canOverride = !!account.canOverrideCheckinStatus;
  const events = await api.get('/events');
  eventSelect.innerHTML = events.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.event_date)})</option>`).join('');
  if (events.length > 0) {
    await loadParticipants(events[0].id);
  } else {
    message.textContent = 'Keine Events vorhanden.';
  }
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
  else if (err.status === 403) { message.textContent = 'Kein Zugriff – nur für Admins/Check-In-Helfer.'; message.className = 'error'; }
}
```

- [ ] **Step 6: Verify visually**

Using Claude Browser tools against the running dev stack:
1. Log in as `admin@pakyrion.local`/`0000`, go to `/admin/checkin.html`, confirm the "Override" column appears with a select per row.
2. Create a throwaway registered participant for an event (or use an existing one), select "Eingecheckt" (checked_in) in their override dropdown — a forward step — confirm it applies immediately with no dialog, and the status pill updates.
3. Select "Angemeldet" (registered) in the same dropdown — a backward step — confirm a "Bist du sicher?" dialog appears; cancel it and confirm the select reverts to "Eingecheckt"; try again and accept, confirm the status pill updates to "Angemeldet" and the normal Check-In button re-enables.
4. Log in as a throwaway `sc`-group user (no `checkin` menu access at all — confirm they can't reach this page), then as a throwaway `sl`-group user (has override by default) and confirm the Override column appears for them too.
5. Clean up all test accounts/registrations created during verification afterward.

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
git add frontend/admin/checkin.html
git commit -m "feat: add check-in status override UI with confirmation dialog"
```

## Self-Review Notes (for the plan author / controller, not a task)

- Spec coverage: covers Abschnitt 3 ("Status-Override mit Bestätigung (Check-In)") of `2026-08-28-charakterklassen-und-hardening-design.md` in full — data model, API, frontend, and the confirm-dialog behavior all match the spec's stated design.
- A lesson from the previous plan in this sequence (Charakter-Klassen) is applied explicitly in Task 1 Step 3: `db/seedGroups.js`'s INSERT statement is updated in the SAME task that adds the migration and `groupDefaults.js` entry, specifically because that exact omission caused a real bug there.
- Type/shape consistency: `user.group.canOverrideCheckinStatus` (Task 1) is consumed identically by Task 2's route permission check. `account.canOverrideCheckinStatus` (top-level, Task 1) is consumed identically by Task 3's frontend gate. `setStatus(eventId, userId, status)`'s return shape (`{user_id, event_id, status, checked_in_at, checked_out_at}`) matches the existing `checkIn`/`checkOut` functions' return shape exactly, so the route handler's response body is consistent with the existing endpoints.
- The new checkbox in Task 1's `admin/groups.html` deliberately does NOT get a `checked` HTML attribute (unlike the character-class `sc` checkbox from the previous plan) — `false` is the safe, correct default for a status-override permission on a brand-new group, so no anti-regression default is needed here the way it was for character classes.
