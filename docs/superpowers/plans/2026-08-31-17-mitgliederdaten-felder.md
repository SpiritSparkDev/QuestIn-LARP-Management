# Mitgliederdaten-Felder überarbeiten Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `users.name`/`invitations.name` into Vorname/Nachname/Rufname, split the single encrypted `emergency_contact_enc` field into Name/Vorname/Telefonnummer, and remove the `pronomen` field entirely.

**Architecture:** Three sequential schema changes to the same two tables (`users`, `invitations`), each following the established pattern from this project's history: a real migration (not a seed-script side effect), backend repository/route updates, frontend form updates, and test updates — landed as three pairs of tasks (backend+tests, then frontend) per field group, so each pair is independently testable before the next begins.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` (Teil 2)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step.
- `firstName`/`lastName`/`nickname` are NEVER added to `ACCOUNT_FIELD_KEYS` (`backend/accountFields.js`) — the current `name` field is NOT permission-gated today (any inviter can set it, any account holder can PATCH their own), and the 3 replacement fields keep that same ungated status. Only `emergencyContactLastName`/`emergencyContactFirstName`/`emergencyContactPhone` (replacing the gated `emergencyContact`) and the removal of `pronomen` touch `ACCOUNT_FIELD_KEYS`.
- Every repository function that currently returns `name: row.name` for read/display purposes (account, member list, member detail, invitation list, participant list) must keep returning a `name` field with the SAME computed value it always had (via the new `displayName()` helper) — this means `admin/members.html`'s member-list table, `admin/checkin.html`'s participant list, and any other pure-display consumer of `.name` require ZERO changes. Only the EDIT forms (account page, member invite/detail forms) are touched, since only they need the 3 fields individually.
- The Notfallkontakt split has NO existing automatic migration path for existing data — a single encrypted free-text field cannot be reliably split into 3 parts. The migration only adds the 3 new (empty) columns and drops the old one; existing Notfallkontakt data is lost. This must be communicated to the user before this plan's branch is merged (call it out explicitly in the merge-decision conversation, not just in this document).
- Every existing test must still pass; the plan's own tasks account for every test file identified as needing updates (see Task 2's file list, gathered by direct repo search, not from memory).

---

### Task 1: Name-Split — Migration + Backend

**Files:**
- Create: `db/migrations/015_split_name_fields.sql`
- Create: `backend/displayName.js`
- Modify: `backend/auth/register.js`
- Modify: `backend/auth/oauth.js`
- Modify: `backend/auth/invite.js`
- Modify: `backend/invitations/repository.js`
- Modify: `backend/accounts/repository.js`
- Modify: `backend/members/repository.js`
- Modify: `backend/members/routes.js`
- Modify: `backend/middleware/authenticate.js`
- Modify: `backend/registrations/repository.js`

**Interfaces:**
- Produces: `displayName({firstName, lastName, nickname})` — returns `nickname` if truthy, else `` `${firstName} ${lastName}`.trim() ``. Used by every repository function below that returns a `name` field for display.
- Produces: `splitFullName(fullName)` — returns `{firstName, lastName}`, splitting on the first space (`firstName` = everything before it, `lastName` = everything after; if no space, `firstName` = the whole trimmed string and `lastName` = `''`). Used only by `oauth.js` (OAuth providers give a single name string, not separate parts).
- Both exported from `backend/displayName.js`.

- [ ] **Step 1: Write the migration**

Create `db/migrations/015_split_name_fields.sql`:

```sql
ALTER TABLE users ADD COLUMN first_name text;
ALTER TABLE users ADD COLUMN last_name text;
ALTER TABLE users ADD COLUMN nickname text;
UPDATE users SET
  first_name = CASE WHEN position(' ' in name) = 0 THEN name ELSE substring(name from 1 for position(' ' in name) - 1) END,
  last_name = CASE WHEN position(' ' in name) = 0 THEN '' ELSE substring(name from position(' ' in name) + 1) END;
ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE users ALTER COLUMN last_name SET NOT NULL;
ALTER TABLE users DROP COLUMN name;

ALTER TABLE invitations ADD COLUMN first_name text;
ALTER TABLE invitations ADD COLUMN last_name text;
ALTER TABLE invitations ADD COLUMN nickname text;
UPDATE invitations SET
  first_name = CASE WHEN position(' ' in name) = 0 THEN name ELSE substring(name from 1 for position(' ' in name) - 1) END,
  last_name = CASE WHEN position(' ' in name) = 0 THEN '' ELSE substring(name from position(' ' in name) + 1) END;
ALTER TABLE invitations ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE invitations ALTER COLUMN last_name SET NOT NULL;
ALTER TABLE invitations DROP COLUMN name;
```

(Best-effort backfill: splits any existing `name` value on its first space. A name with no space becomes `first_name = <whole name>`, `last_name = ''`. This is a one-time, lossy-but-reasonable migration for existing rows — matches the same "split on first space" heuristic used in Step 3 below for OAuth signups, so behavior is consistent across the app.)

- [ ] **Step 2: Create the shared helper**

Create `backend/displayName.js`:

```javascript
export function displayName({ firstName, lastName, nickname }) {
  return nickname || `${firstName} ${lastName}`.trim();
}

export function splitFullName(fullName) {
  const trimmed = (fullName ?? '').trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1) };
}
```

- [ ] **Step 3: Update `backend/auth/register.js`**

Read the current file first (full content, 109 lines). Change the destructure and validation:
```javascript
  const { password, name } = body;
  const email = body.email?.toLowerCase();
  if (!email || !password || !name) {
    return { status: 400, body: { error: 'email, password, and name are required' } };
  }
```
to:
```javascript
  const { password, firstName, lastName, nickname } = body;
  const email = body.email?.toLowerCase();
  if (!email || !password || !firstName || !lastName) {
    return { status: 400, body: { error: 'email, password, firstName, and lastName are required' } };
  }
```
Change the INSERT:
```javascript
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, group_id, name)
       VALUES ($1, $2, (SELECT id FROM groups WHERE key = 'sc'), $3) RETURNING id`,
      [email, passwordHash, name]
    );
```
to:
```javascript
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, group_id, first_name, last_name, nickname)
       VALUES ($1, $2, (SELECT id FROM groups WHERE key = 'sc'), $3, $4, $5) RETURNING id`,
      [email, passwordHash, firstName, lastName, nickname ?? null]
    );
```
Nothing else in this file changes (the verification-token logic, resend logic, etc. never reference `name`).

- [ ] **Step 4: Update `backend/auth/oauth.js`**

Read the current file first (full content, 179 lines). Add the import at the top, alongside the existing imports:
```javascript
import { rateLimit } from '../middleware/rateLimit.js';
```
becomes:
```javascript
import { rateLimit } from '../middleware/rateLimit.js';
import { splitFullName } from '../displayName.js';
```
Change `findOrCreateOAuthUser`'s INSERT (the function's `else` branch, for brand-new OAuth signups):
```javascript
  } else {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, group_id, name, email_verified)
       VALUES ($1, NULL, (SELECT id FROM groups WHERE key = 'sc'), $2, $3) RETURNING id`,
      [normalizedEmail, name || normalizedEmail, !!emailVerifiedByProvider]
    );
    userId = rows[0].id;
  }
```
to:
```javascript
  } else {
    const { firstName, lastName } = splitFullName(name || normalizedEmail);
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, group_id, first_name, last_name, email_verified)
       VALUES ($1, NULL, (SELECT id FROM groups WHERE key = 'sc'), $2, $3, $4) RETURNING id`,
      [normalizedEmail, firstName, lastName, !!emailVerifiedByProvider]
    );
    userId = rows[0].id;
  }
```
(The provider's own single `name` value is split via `splitFullName`, same first-space heuristic as the migration's backfill. `nickname` is left unset/NULL — OAuth never provides one. Nothing else in this file changes — the `name` variable destructured at line 109 from `provider.extractUser(info)` is still needed as an input to `findOrCreateOAuthUser`, only what happens to it INSIDE that function changes.)

- [ ] **Step 5: Update `backend/invitations/repository.js`**

Read the current file first (full content, 93 lines). Change `SELECT_COLUMNS`:
```javascript
const SELECT_COLUMNS = `
  id, token, email, name, group_id,
  address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, pronomen_enc,
  invited_by, expires_at, created_at, redeemed_at
`;
```
to:
```javascript
const SELECT_COLUMNS = `
  id, token, email, first_name, last_name, nickname, group_id,
  address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, pronomen_enc,
  invited_by, expires_at, created_at, redeemed_at
`;
```
Change `decryptInvitation`:
```javascript
function decryptInvitation(row) {
  return {
    id: row.id,
    token: row.token,
    email: row.email,
    name: row.name,
    groupId: row.group_id,
```
to:
```javascript
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
```
Add the import at the top:
```javascript
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
```
becomes:
```javascript
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
import { displayName } from '../displayName.js';
```
Change `createInvitation`'s signature and INSERT:
```javascript
export async function createInvitation({ email, name, groupId, invitedBy, address, birthdate, phone, emergencyContact, medicalNotes, pronomen }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const { rows } = await query(
    `INSERT INTO invitations (token, email, name, group_id, address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, pronomen_enc, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${SELECT_COLUMNS}`,
    [
      token, email, name, groupId,
```
to:
```javascript
export async function createInvitation({ email, firstName, lastName, nickname, groupId, invitedBy, address, birthdate, phone, emergencyContact, medicalNotes, pronomen }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const { rows } = await query(
    `INSERT INTO invitations (token, email, first_name, last_name, nickname, group_id, address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, pronomen_enc, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${SELECT_COLUMNS}`,
    [
      token, email, firstName, lastName, nickname ?? null, groupId,
```
(The rest of the parameter list — `address !== undefined ? encryptField(address) : null,` etc. — is unchanged, just shifted down; the placeholder numbers `$5` through `$12` in the VALUES clause above now correspond to `groupId` through `expiresAt`, one position later than before since `nickname` was inserted — read the current file's exact remaining lines and renumber the placeholders consistently, the encrypted-fields params themselves don't change content.)

- [ ] **Step 6: Update `backend/accounts/repository.js`**

Read the current file first (full content, 65 lines). Add the import:
```javascript
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
```
becomes:
```javascript
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
import { displayName } from '../displayName.js';
```
Change `decryptAccount`:
```javascript
function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    group: { key: row.group_key, name: row.group_name },
```
to:
```javascript
function decryptAccount(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    nickname: row.nickname,
    name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),
    group: { key: row.group_key, name: row.group_name },
```
Change `SELECT_COLUMNS`:
```javascript
const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
```
to:
```javascript
const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified,
```
Change `updateAccount`:
```javascript
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
to:
```javascript
export async function updateAccount(userId, fields) {
  const { rows } = await query(
    `UPDATE users SET
       first_name = COALESCE($2, first_name),
       last_name = COALESCE($3, last_name),
       nickname = COALESCE($4, nickname),
       address_enc = COALESCE($5, address_enc),
       birthdate_enc = COALESCE($6, birthdate_enc),
       phone_enc = COALESCE($7, phone_enc),
       emergency_contact_enc = COALESCE($8, emergency_contact_enc),
       medical_notes_enc = COALESCE($9, medical_notes_enc),
       pronomen_enc = COALESCE($10, pronomen_enc)
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
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

- [ ] **Step 7: Update `backend/members/repository.js`**

Read the current file first (full content, 77 lines). Add the import, change `SELECT_COLUMNS`, `decryptMember`, and `updateMember` following the IDENTICAL pattern as Step 6 (same field renames, same `displayName` computed field, same COALESCE additions) — this file's current shape mirrors `accounts/repository.js` closely (it's the admin-facing sibling of the same account data). Specifically:
- Add `import { displayName } from '../displayName.js';` to the imports.
- `SELECT_COLUMNS`: replace `users.name` with `users.first_name, users.last_name, users.nickname`.
- `decryptMember`: replace `name: row.name,` with `firstName: row.first_name, lastName: row.last_name, nickname: row.nickname, name: displayName({ firstName: row.first_name, lastName: row.last_name, nickname: row.nickname }),`.
- `updateMember`: this function CURRENTLY DOES NOT update `name` at all (there is no `name = ...` in its `UPDATE users SET` clause today — member renaming has never been possible via this endpoint). Add it now: add `first_name = COALESCE($9, first_name), last_name = COALESCE($9+1, last_name), nickname = COALESCE($9+2, nickname)` as three new SET clauses (use the actual next available placeholder numbers after reading the current file — the existing clause has `group_id` through `pronomen_enc` at placeholders `$2` through `$8`, so the three new ones become `$9`, `$10`, `$11`), and correspondingly add `fields.firstName ?? null, fields.lastName ?? null, fields.nickname ?? null,` to the parameter array (append at the end, after the existing `pronomen` param). Also change `listMembers()`'s `ORDER BY users.name` to `ORDER BY users.last_name, users.first_name`.

- [ ] **Step 8: Update `backend/members/routes.js`**

Read the current file first (full content, 130 lines). Change the `GET /members` handler's invited-mapping:
```javascript
  const invited = invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    name: inv.name,
    status: 'invited',
    expired: new Date(inv.expiresAt) < new Date(),
  }));
```
stays structurally the same — `inv.name` still exists (it's now the COMPUTED display name from Step 5's `decryptInvitation`, not a raw column), so this line needs NO change at all. (Confirm this by re-reading Step 5's `decryptInvitation` change — it returns both `firstName`/`lastName`/`nickname` AND a computed `name`.)

Change the invite handler's destructure and validation:
```javascript
  const { email, name, group, ...rest } = body;
  if (!email || !name) {
    return { status: 400, body: { error: 'email and name are required' } };
  }
```
to:
```javascript
  const { email, firstName, lastName, nickname, group, ...rest } = body;
  if (!email || !firstName || !lastName) {
    return { status: 400, body: { error: 'email, firstName, and lastName are required' } };
  }
```
Change the `createInvitation` call:
```javascript
  const invitation = await createInvitation({
    email: email.toLowerCase(),
    name,
    groupId: groupRows[0].id,
```
to:
```javascript
  const invitation = await createInvitation({
    email: email.toLowerCase(),
    firstName,
    lastName,
    nickname,
    groupId: groupRows[0].id,
```
(The rest of that call — `invitedBy`, `address`, `birthdate`, etc. from `rest` — is unchanged.)

- [ ] **Step 9: Update `backend/middleware/authenticate.js`**

Read the current file first (full content, 46 lines). `ctx.user.name` is set here but consumed nowhere else in the codebase (confirmed via `grep -rn "user\.name" backend/ --include="*.js"` returning zero matches outside this file) — since `users.name` no longer exists as a column after this task's migration, remove it entirely rather than replacing it with unused fields. Change:
```javascript
    const { rows } = await query(
      `SELECT users.id, users.email, users.name,
              groups.id AS group_id, groups.key AS group_key, groups.name AS group_name,
```
to:
```javascript
    const { rows } = await query(
      `SELECT users.id, users.email,
              groups.id AS group_id, groups.key AS group_key, groups.name AS group_name,
```
and:
```javascript
    const user = {
      id: row.id,
      email: row.email,
      name: row.name,
      group: {
```
to:
```javascript
    const user = {
      id: row.id,
      email: row.email,
      group: {
```

- [ ] **Step 10: Update `backend/registrations/repository.js`**

Read the current file first (full content, 171 lines). Add the import:
```javascript
import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { applyTransition } from './statusMachine.js';
```
becomes:
```javascript
import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { applyTransition } from './statusMachine.js';
import { displayName } from '../displayName.js';
```
Change `listParticipantsForEvent`:
```javascript
export async function listParticipantsForEvent(eventId) {
  const { rows: registrations } = await query(
    `SELECT r.user_id, u.name, r.status, r.checked_in_at, r.checked_out_at
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.name`,
    [eventId]
  );
```
to:
```javascript
export async function listParticipantsForEvent(eventId) {
  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.checked_in_at, r.checked_out_at
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
```
and further down, in the `.map(...)` that builds the return value:
```javascript
  return registrations.map((r) => ({
    userId: r.user_id,
    name: r.name,
    status: r.status,
```
to:
```javascript
  return registrations.map((r) => ({
    userId: r.user_id,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    status: r.status,
```

- [ ] **Step 11: Run the affected tests to confirm the shape (expect failures — Task 2 fixes them)**

Run: `node --test tests/integration/accounts.test.js`
Expected: FAILS — every test file that creates a user via raw SQL still uses the old `name` column, which no longer exists. This is expected; Task 2 fixes every affected test file. Do not attempt to fix any test in this task.

- [ ] **Step 12: Commit**

```bash
git add db/migrations/015_split_name_fields.sql backend/displayName.js backend/auth/register.js backend/auth/oauth.js backend/auth/invite.js backend/invitations/repository.js backend/accounts/repository.js backend/members/repository.js backend/members/routes.js backend/middleware/authenticate.js backend/registrations/repository.js
git commit -m "feat: split users/invitations name into firstName/lastName/nickname"
```

---

### Task 2: Name-Split — Test Suite

**Files:**
- Modify: `tests/integration/characters.test.js`
- Modify: `tests/integration/checkin.test.js`
- Modify: `tests/integration/groups.test.js`
- Modify: `tests/integration/events.test.js`
- Modify: `tests/integration/members.test.js`
- Modify: `tests/integration/registrations.test.js`
- Modify: `tests/integration/nscSchema.test.js`
- Modify: `tests/integration/middleware.test.js`
- Modify: `tests/integration/schema-registrations.test.js`
- Modify: `tests/integration/sessions.test.js`
- Modify: `tests/integration/invitations.test.js`
- Modify: `tests/integration/oauth.test.js`
- Modify: `tests/integration/schema-events.test.js`
- Modify: `tests/integration/schema-oauth.test.js`
- Modify: `tests/integration/schema-users.test.js`
- Modify: `tests/integration/seedGroups.test.js`
- Modify: `tests/integration/accounts.test.js`
- Modify: `tests/integration/auth-register.test.js`
- Modify: `tests/integration/auth-login.test.js`
- Modify: `tests/integration/auth-password-reset.test.js`

**Interfaces:**
- Consumes: the migration + backend changes from Task 1 — every raw `INSERT INTO users (...)` and every `/auth/register`/`/members/invite` request body in this test suite must supply `first_name`/`last_name` (raw SQL) or `firstName`/`lastName` (HTTP body) instead of `name`.

This is a large, purely mechanical task across many files — every single change follows one of two identical patterns. Read each file's CURRENT content before editing (don't guess) — this list and the quoted snippets below were gathered by direct repo search this session, but re-verify before writing, since exact line numbers shift as you edit earlier files in the same session.

**Pattern A — raw SQL `INSERT INTO users`.** Every occurrence of `name, group_id` (or `name, group_id, email_verified`, or `password_hash, group_id, name, email_verified` etc. — column ORDER varies per file) in an `INSERT INTO users (...)` statement becomes `first_name, last_name, group_id` (same relative position, `name` replaced by TWO columns). The VALUES placeholder list gains one extra `$N` for the split, and the single literal name string (e.g. `'Char Test'`) becomes two literal strings split on the space (e.g. `'Char', 'Test'` — if the original literal has no space, e.g. `'Test'` alone, use `'Test', ''`). If `name` was a bound parameter (not a literal) rather than a literal string, split it into two bound parameters instead.

Worked example — `tests/integration/characters.test.js`, `makeUserAndSession` (lines 23-30), converts from:
```javascript
async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Char Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`chars-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}
```
to:
```javascript
async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Char', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`chars-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}
```

Apply the IDENTICAL transformation (same literal-name split, same column-list insertion of `first_name, last_name` in place of `name`) to every one of these, using the literal name already present in each (split on its own first space, or `'<literal>', ''` if it has none):
- `tests/integration/checkin.test.js:20-27` (`makeUserAndSession`, literal `'Checkin Test'`)
- `tests/integration/groups.test.js:19-26` (`makeUserAndSession`, literal `'Groups Test'`)
- `tests/integration/events.test.js:19-27` (`makeUserAndSession`, literal `'Events Test'` — note this file's `createSession` import is inlined inside the function body, leave that inline import untouched)
- `tests/integration/members.test.js:20-27` (`makeUserAndSession`, literal `'Members Test'`) AND `tests/integration/members.test.js:178-181` (inline insert inside a test body, literal `'Existing Member'`)
- `tests/integration/registrations.test.js:20-27` (`makeUserAndSession`, literal `'Reg Test'` — this one has NO `groupKey` parameter, hardcodes `'sc'` in the SQL text itself; keep that hardcoding, only split the name) AND `tests/integration/registrations.test.js:117-120` (inline insert, literal `'Race Helper'`)
- `tests/integration/nscSchema.test.js:23-30` (`makeUserAndSession`, literal `'NSC Schema Test'`)
- `tests/integration/middleware.test.js:18-24` (function is named `makeUser`, not `makeUserAndSession` — same pattern, literal `'Mid Test'`)
- `tests/integration/schema-registrations.test.js:16-22` (`makeUser`, literal `'Reg Test'`)
- `tests/integration/sessions.test.js:16-22` (`makeUser`, literal `'Test'` — no space, becomes `'Test', ''`)
- `tests/integration/invitations.test.js:21-24` (function `makeAdmin`, literal `'Inviter'` — no space, becomes `'Inviter', ''`)
- `tests/integration/oauth.test.js:98` AND `tests/integration/oauth.test.js` (a second, textually identical occurrence further down — search for `'Existing User'` to find both) — literal `'Existing User'`, column list is `password_hash, group_id, name, email_verified` (different order than the others: `name` sits between `group_id` and `email_verified`) — replace `name` with `first_name, last_name` at that same position, keeping `password_hash`/`group_id`/`email_verified` exactly where they are.
- `tests/integration/schema-events.test.js:38-40` (literal `'FK Test'`)
- `tests/integration/schema-oauth.test.js:21-23` (literal `'OAuth Uniq'`)
- `tests/integration/schema-users.test.js:26-28` (literal `'A'` — no space, becomes `'A', ''`) AND `tests/integration/schema-users.test.js:30-31` (literal `'B'` — no space, becomes `'B', ''`)
- `tests/integration/seedGroups.test.js:48-51` (literal `'Backfill Test'` — note this INSERT's column list is `email, name, role`, NOT `email, name, group_id` like the others, since this test specifically exercises the pre-migration-014 schema shape; replace `name` with `first_name, last_name` in that list, leave `role` untouched)

**Pattern B — HTTP request body / repository-call `name:` field.** Every `name: '<literal>'` (or `name,` shorthand) in a JSON body sent to `POST /auth/register` or `POST /members/invite`, or in an object passed to `createInvitation({...})`, becomes `firstName: '<first part>', lastName: '<second part>'` (split the same way as Pattern A). Every assertion reading `.name` back from a `GET`/`PATCH /account` or `GET /members`/`GET /members/:id` response STAYS `.name` unchanged — Task 1's `displayName()` computation means the response still has a `name` field with the same value it always had, only the REQUEST bodies change.

Worked example — `tests/integration/accounts.test.js`, the test `'GET /account returns the logged-in user's account with null sensitive fields initially'` and its neighbors. The registration helper `registerLoginAndGetCookie` (near the top of the file) has:
```javascript
  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Account Test' }),
  });
```
becomes:
```javascript
  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, firstName: 'Account', lastName: 'Test' }),
  });
```
Every assertion in this same file that checks `body.name`/`patched.name` (e.g. `assert.equal(body.name, 'Account Test');`) STAYS EXACTLY AS IT IS — `'Account Test'` is still the correct expected display name, since `displayName({firstName: 'Account', lastName: 'Test'})` produces exactly that. The one exception: the test `'PATCH /account silently ignores an nscData field...'` sends `body: JSON.stringify({ name: 'Still Works', nscData: {...} })` and asserts `assert.equal(body.name, 'Still Works');` — since `name` alone (without a space-splittable structure matching firstName/lastName) is no longer a valid PATCH field, change this specific test's body to `{ firstName: 'Still', lastName: 'Works', nscData: {...} }` and its assertion stays `assert.equal(body.name, 'Still Works');` unchanged (still produces that exact display name).

Apply the identical request-body transformation (split `name:` into `firstName:`/`lastName:`, leave every response-reading `.name` assertion untouched) to every occurrence:
- `tests/integration/accounts.test.js`: the registration helper (as shown above) and the `'Still Works'` PATCH body (as shown above).
- `tests/integration/auth-register.test.js`: all 8 occurrences of `name: '<literal>'` in `POST /auth/register` bodies (lines ~31, 67, 78, 87, 102, 124, 169, 200 as of this plan's writing — re-locate by searching for `name:` in the file). Every one becomes `firstName: '<part1>', lastName: '<part2>'` using that same test's own literal (e.g. `name: 'Test User'` → `firstName: 'Test', lastName: 'User'`; `name: 'Rate Limit Test'` → `firstName: 'Rate', lastName: 'Limit Test'` — only split on the FIRST space, so a 3-word name's last two words both go into `lastName`, matching Task 1's `splitFullName`/migration semantics exactly).
- `tests/integration/auth-login.test.js`: 2 occurrences (`name: 'Login Test'`, `name: 'Unverified'` — the latter has no space, becomes `firstName: 'Unverified', lastName: ''`).
- `tests/integration/auth-password-reset.test.js`: 1 occurrence (`name: 'Reset Test'`).
- `tests/integration/members.test.js`: 8 occurrences of `name: '<literal>'` in `POST /members/invite` bodies — apply the same split to each (e.g. `name: 'Invited Member'` → `firstName: 'Invited', lastName: 'Member'`; `name: 'Again'` → `firstName: 'Again', lastName: ''`).
- `tests/integration/invitations.test.js`: 5 occurrences of `name: '<literal>'` passed directly to `createInvitation({...})` (not an HTTP body — this file calls the repository function directly) — same split pattern (e.g. `name: 'Invited Person'` → `firstName: 'Invited', lastName: 'Person'`).
- `tests/integration/oauth.test.js`: the assertion `assert.equal(rows[0].name, 'OAuth Test');` (reading a raw DB row, not a decrypted object) must change to `assert.equal(rows[0].first_name, 'OAuth');` plus `assert.equal(rows[0].last_name, 'Test');` (two assertions replacing one, since this is a raw SQL SELECT of `name` — also update that SELECT itself: `'SELECT email_verified, password_hash, name FROM users WHERE id = $1'` becomes `'SELECT email_verified, password_hash, first_name, last_name FROM users WHERE id = $1'`). The mocked-provider-response `name: 'Callback User'` (fed into the OAuth flow, not a users-table column) stays completely UNCHANGED — that's the input the provider "returns", which Task 1's `splitFullName` will split automatically inside `findOrCreateOAuthUser`; do not touch it. `PROVIDERS.discord.extractUser(...)`'s own tests (`assert.equal(withGlobalName.name, 'Global Name');` etc.) also stay unchanged — those test a DIFFERENT `.name` (the OAuth-provider extraction helper's own return shape), unrelated to the `users` table.

- [ ] **Step 1: Add schema-assertion tests to `tests/integration/schema-users.test.js`**

Read the file's current content first (73 lines) — it already has a same-style test for a prior schema change (`'users.nsc_data column no longer exists after migration'`, around line 55). Add two new tests following that exact style, anywhere after the existing tests:

```javascript
test('users.name column no longer exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'name'`
  );
  assert.equal(rows.length, 0);
});

test('users.first_name and users.last_name columns exist and are NOT NULL', async () => {
  const { rows } = await query(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'users' AND column_name IN ('first_name', 'last_name')`
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.is_nullable, 'NO', `${row.column_name} should be NOT NULL`);
  }
});
```

(Read the file's actual imports/setup first — `query` and `assert` are almost certainly already imported given the existing tests in this file follow the same shape; match whatever import style the file already uses.)

- [ ] **Step 2: Run every touched test file**

Run: `node --test tests/integration/characters.test.js tests/integration/checkin.test.js tests/integration/groups.test.js tests/integration/events.test.js tests/integration/members.test.js tests/integration/registrations.test.js tests/integration/nscSchema.test.js tests/integration/middleware.test.js tests/integration/schema-registrations.test.js tests/integration/sessions.test.js tests/integration/invitations.test.js tests/integration/oauth.test.js tests/integration/schema-events.test.js tests/integration/schema-oauth.test.js tests/integration/schema-users.test.js tests/integration/seedGroups.test.js tests/integration/accounts.test.js tests/integration/auth-register.test.js tests/integration/auth-login.test.js tests/integration/auth-password-reset.test.js --test-concurrency=1`

Expected: all PASS. (`--test-concurrency=1` is required — this project's whole suite shares one mutable Postgres instance with no per-file isolation, per `package.json`'s own `test` script.)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/characters.test.js tests/integration/checkin.test.js tests/integration/groups.test.js tests/integration/events.test.js tests/integration/members.test.js tests/integration/registrations.test.js tests/integration/nscSchema.test.js tests/integration/middleware.test.js tests/integration/schema-registrations.test.js tests/integration/sessions.test.js tests/integration/invitations.test.js tests/integration/oauth.test.js tests/integration/schema-events.test.js tests/integration/schema-oauth.test.js tests/integration/schema-users.test.js tests/integration/seedGroups.test.js tests/integration/accounts.test.js tests/integration/auth-register.test.js tests/integration/auth-login.test.js tests/integration/auth-password-reset.test.js
git commit -m "test: update test suite for firstName/lastName/nickname split"
```

---

### Task 3: Name-Split — Frontend

**Files:**
- Modify: `frontend/account.html`
- Modify: `frontend/admin/members.html`

**Interfaces:**
- Consumes: `POST /auth/register` now requires `firstName`/`lastName` (optional `nickname`) instead of `name`. `PATCH /account`, `PATCH /members/:id`, `POST /members/invite` accept the same 3-field shape. Every response that used to include `name` still does (computed), so read-only displays are unaffected.

- [ ] **Step 1: `frontend/account.html`**

Read the current file first (91 lines, was touched in the previous plan for the birthdate formatter — confirm that change is present and don't disturb it). Replace the single Name field:
```html
      <label for="name">Name</label>
      <input id="name" name="name" type="text">
```
with:
```html
      <label for="firstName">Vorname</label>
      <input id="firstName" name="firstName" type="text" required>
      <label for="lastName">Nachname</label>
      <input id="lastName" name="lastName" type="text" required>
      <label for="nickname">Rufname</label>
      <input id="nickname" name="nickname" type="text">
```
Change the field-population loop in `loadAccount()`:
```javascript
    for (const field of ['name', 'address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen']) {
      form.elements[field].value = account[field] ?? '';
    }
```
to:
```javascript
    for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen']) {
      form.elements[field].value = account[field] ?? '';
    }
```
Nothing else in this file changes — the submit handler already does `Object.fromEntries(new FormData(form))`, which will automatically include the 3 new field names once the markup above is in place, no code change needed there.

- [ ] **Step 2: `frontend/admin/members.html`**

Read the current file first (it was touched in the previous plan for the group-edit-dialog-adjacent birthdate wiring — confirm that's present). Two separate forms need the split: the invite form (static markup) and the detail-edit form (dynamically built, but currently has NO name field at all since member renaming was never possible before Task 1 added it).

Replace the invite form's Name field:
```html
          <div>
            <label for="invite-name">Name</label>
            <input id="invite-name" name="name" type="text" required>
          </div>
```
with:
```html
          <div>
            <label for="invite-first-name">Vorname</label>
            <input id="invite-first-name" name="firstName" type="text" required>
          </div>
          <div>
            <label for="invite-last-name">Nachname</label>
            <input id="invite-last-name" name="lastName" type="text" required>
          </div>
          <div>
            <label for="invite-nickname">Rufname</label>
            <input id="invite-nickname" name="nickname" type="text">
          </div>
```
(This grid currently has `grid-template-columns:1fr 1fr` for 2 columns — with 5 fields now (firstName, lastName, nickname, email — email's own `<div>` stays where it is below/after), leave the CSS as-is; a 2-column grid with 5 items just wraps to a 3rd row, which is acceptable and matches how this project handles every other odd-count field grid.)

The invite form's submit handler does `const payload = Object.fromEntries(formData);` — this automatically picks up the 3 new field names once the markup changes, no code change needed there.

For the member-DETAIL view, add name-editing to `buildDetailFieldInputs` — read the function's current exact content first (it loops over `ALL_FIELD_KEYS`, which does NOT include name fields; add them explicitly, not via that loop, since first/last/nickname aren't gated the way the rest of `ALL_FIELD_KEYS` is). Add this at the START of `buildDetailFieldInputs(container, values = {})`, before the existing `container.innerHTML = ALL_FIELD_KEYS.map(...)` line — change:
```javascript
function buildDetailFieldInputs(container, values = {}) {
  container.innerHTML = ALL_FIELD_KEYS.map((key) => {
```
to:
```javascript
function buildDetailFieldInputs(container, values = {}) {
  const nameFieldsHtml = `
    <label for="field-firstName">Vorname</label>
    <input id="field-firstName" data-field="firstName" type="text" value="${escapeHtml(values.firstName ?? '')}">
    <label for="field-lastName">Nachname</label>
    <input id="field-lastName" data-field="lastName" type="text" value="${escapeHtml(values.lastName ?? '')}">
    <label for="field-nickname">Rufname</label>
    <input id="field-nickname" data-field="nickname" type="text" value="${escapeHtml(values.nickname ?? '')}">
  `;
  container.innerHTML = nameFieldsHtml + ALL_FIELD_KEYS.map((key) => {
```
(The existing `container.querySelector('[data-field="birthdate"]')` call from the previous plan's Task 1 still works correctly after this change — it queries the whole container after `innerHTML` is set, regardless of where in the string the birthdate input landed.)

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: navigate to `/account.html`, confirm Vorname/Nachname/Rufname fields show and save correctly (edit and check the success message, reload and confirm values persisted). Navigate to `/admin/members.html` as admin, confirm the invite form has the 3 new fields and successfully creates an invitation; open an existing member's detail view, confirm Vorname/Nachname/Rufname now show and are editable, save a change and confirm it persists. Screenshot as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/account.html frontend/admin/members.html
git commit -m "feat: split Name into Vorname/Nachname/Rufname in account and member forms"
```

---

### Task 4: Notfallkontakt-Split — Migration + Backend

**Files:**
- Create: `db/migrations/016_split_emergency_contact_fields.sql`
- Modify: `backend/accountFields.js`
- Modify: `backend/accounts/repository.js`
- Modify: `backend/members/repository.js`
- Modify: `backend/invitations/repository.js`
- Modify: `backend/auth/invite.js`
- Modify: `backend/members/routes.js` (no code change expected — verify)
- Modify: `db/groupDefaults.js`
- Modify: `tests/integration/accounts.test.js`

**Interfaces:**
- Replaces the single `emergencyContact` account field with three: `emergencyContactLastName`, `emergencyContactFirstName`, `emergencyContactPhone`. All three are encrypted, all three gated by `ACCOUNT_FIELD_KEYS` exactly where `emergencyContact` used to be.

- [ ] **Step 1: Write the migration**

Create `db/migrations/016_split_emergency_contact_fields.sql`. Existing Notfallkontakt data CANNOT be automatically split (it's free text) — the 3 new columns start empty for every existing user/invitation, and the old data is dropped:

```sql
ALTER TABLE users ADD COLUMN emergency_contact_last_name_enc bytea;
ALTER TABLE users ADD COLUMN emergency_contact_first_name_enc bytea;
ALTER TABLE users ADD COLUMN emergency_contact_phone_enc bytea;
ALTER TABLE users DROP COLUMN emergency_contact_enc;

ALTER TABLE invitations ADD COLUMN emergency_contact_last_name_enc bytea;
ALTER TABLE invitations ADD COLUMN emergency_contact_first_name_enc bytea;
ALTER TABLE invitations ADD COLUMN emergency_contact_phone_enc bytea;
ALTER TABLE invitations DROP COLUMN emergency_contact_enc;

UPDATE groups SET account_fields = (account_fields - 'emergencyContact') || '["emergencyContactLastName", "emergencyContactFirstName", "emergencyContactPhone"]'::jsonb
WHERE account_fields ? 'emergencyContact';
```

(The final `UPDATE` is the same "retroactive grant" pattern used by every prior group-permission migration in this project — `db/seedGroups.js`'s `ON CONFLICT (key) DO NOTHING` never touches already-seeded rows, so already-existing `admin`/`orga` groups need this explicit rewrite to keep their Notfallkontakt-editing capability under the new field names.)

- [ ] **Step 2: Update `backend/accountFields.js`**

```javascript
export const ACCOUNT_FIELD_KEYS = ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'pronomen', 'group'];
```

- [ ] **Step 3: Update `backend/accounts/repository.js`**

Read the current file (as modified by Task 1). Change `decryptAccount`:
```javascript
    emergencyContact: decryptField(row.emergency_contact_enc),
```
to:
```javascript
    emergencyContactLastName: decryptField(row.emergency_contact_last_name_enc),
    emergencyContactFirstName: decryptField(row.emergency_contact_first_name_enc),
    emergencyContactPhone: decryptField(row.emergency_contact_phone_enc),
```
Change `SELECT_COLUMNS`:
```javascript
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc, users.pronomen_enc,
```
to:
```javascript
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc, users.pronomen_enc,
```
Change `updateAccount`'s SQL and params — replace the single `emergency_contact_enc = COALESCE($8, emergency_contact_enc),` clause with three, renumbering every subsequent placeholder by +2 (this file already has `medical_notes_enc`/`pronomen_enc` after it — read the current file after Task 1's edits and renumber precisely):
```javascript
       emergency_contact_last_name_enc = COALESCE($8, emergency_contact_last_name_enc),
       emergency_contact_first_name_enc = COALESCE($9, emergency_contact_first_name_enc),
       emergency_contact_phone_enc = COALESCE($10, emergency_contact_phone_enc),
```
and the corresponding params, replacing the single `fields.emergencyContact !== undefined ? encryptField(fields.emergencyContact) : null,` with:
```javascript
      fields.emergencyContactLastName !== undefined ? encryptField(fields.emergencyContactLastName) : null,
      fields.emergencyContactFirstName !== undefined ? encryptField(fields.emergencyContactFirstName) : null,
      fields.emergencyContactPhone !== undefined ? encryptField(fields.emergencyContactPhone) : null,
```

- [ ] **Step 4: Update `backend/members/repository.js`**

Apply the IDENTICAL transformation as Step 3 (same field renames, same 3-way COALESCE split) to this file's `SELECT_COLUMNS`, `decryptMember`, and `updateMember` — it mirrors `accounts/repository.js` exactly for this field, per the same reasoning as Task 1 Step 7.

- [ ] **Step 5: Update `backend/invitations/repository.js`**

Apply the same transformation: `SELECT_COLUMNS` gains the 3 new `_enc` columns in place of `emergency_contact_enc`; `decryptInvitation` returns `emergencyContactLastName`/`emergencyContactFirstName`/`emergencyContactPhone` instead of `emergencyContact`; `createInvitation`'s signature gains the 3 new named params in place of `emergencyContact`, and its INSERT statement's column list + params follow the same pattern (3 columns/params replacing 1, each `encryptField`-wrapped exactly like the existing `address`/`phone` params are).

- [ ] **Step 6: Update `backend/auth/invite.js`**

Read the current file (as modified by no prior task — Task 1 didn't touch this file's redemption INSERT beyond what Task 1 already covers for name). The redemption INSERT currently has:
```javascript
        `INSERT INTO users (email, password_hash, group_id, name, email_verified, address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, pronomen_enc)
         VALUES ($1, $2, $3, $4, true,
           (SELECT address_enc FROM invitations WHERE id = $5),
           (SELECT birthdate_enc FROM invitations WHERE id = $5),
           (SELECT phone_enc FROM invitations WHERE id = $5),
           (SELECT emergency_contact_enc FROM invitations WHERE id = $5),
           (SELECT medical_notes_enc FROM invitations WHERE id = $5),
           (SELECT pronomen_enc FROM invitations WHERE id = $5))
         RETURNING id`,
        [invitation.email, passwordHash, invitation.groupId, invitation.name, invitation.id]
```
Note: this file was NOT yet updated for Task 1's name split in this plan's text above (Task 1's file list didn't include it) — re-check: **`backend/auth/invite.js` IS in Task 1's file list**, so by the time you reach this task, `invitation.name` here should already be `invitation.firstName, invitation.lastName, invitation.nickname` and the column list should already say `first_name, last_name, nickname` in place of `name`. Read the CURRENT file (post-Task-1) to confirm, then apply ONLY the emergency-contact change on top of that: replace `emergency_contact_enc` (both the destination column name in the outer INSERT's column list AND the `(SELECT emergency_contact_enc FROM invitations WHERE id = $5)` subquery) with three columns/subqueries:
```javascript
           (SELECT emergency_contact_last_name_enc FROM invitations WHERE id = $5),
           (SELECT emergency_contact_first_name_enc FROM invitations WHERE id = $5),
           (SELECT emergency_contact_phone_enc FROM invitations WHERE id = $5),
```
(3 subqueries replacing 1, in both the column list and the VALUES clause — no new bound parameters needed since these are all subqueries keyed on the same `$5` invitation id, exactly like the existing `address_enc`/`phone_enc` subqueries already are.)

- [ ] **Step 7: Verify `backend/members/routes.js` needs no change**

Read the file. The invite handler already does `const { email, firstName, lastName, nickname, group, ...rest } = body;` (per Task 1 Step 8) and passes `...rest` fields straight through to `createInvitation`, gated by `filterToAllowedFields(fieldsToCheck, user.group.accountFields)` against `ACCOUNT_FIELD_KEYS` (updated in Step 2 above). Since `emergencyContactLastName`/`emergencyContactFirstName`/`emergencyContactPhone` arrive as ordinary keys inside `rest` (the caller sends 3 separate fields instead of 1), and `createInvitation` (Step 5) now accepts those 3 names directly, NO code change is needed in this file — confirm this by re-reading it, and if you find a hardcoded reference to `rest.emergencyContact` anywhere (there is one, in the `createInvitation({...})` call), update it: change `emergencyContact: rest.emergencyContact,` to `emergencyContactLastName: rest.emergencyContactLastName, emergencyContactFirstName: rest.emergencyContactFirstName, emergencyContactPhone: rest.emergencyContactPhone,`.

- [ ] **Step 8: Update `db/groupDefaults.js`**

Read the current file. For the `admin` and `orga` entries (the only two with `emergencyContact` in their `accountFields` array today), replace `'emergencyContact'` with the three new keys:
```javascript
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'pronomen', 'group'],
```
(for `admin`) and the equivalent without `'group'` for `orga`. Every other group's `accountFields: []` stays unchanged.

- [ ] **Step 9: Add round-trip coverage in `tests/integration/accounts.test.js`**

There is currently NO test coverage for `emergencyContact` anywhere in the test suite (confirmed by direct search) — the old field was untested. Since this plan removes the old field and this is a natural point to add coverage for its replacement, extend the existing PATCH test. Read the current file first (as modified by Task 2) — find the test `'PATCH /account encrypts and returns sensitive fields; unspecified fields survive a partial update'`, and add the 3 new fields to its existing PATCH body and assertions, following the exact same pattern already used there for `address`/`phone`:
```javascript
  const patchRes = await fetch(`http://localhost:${port}/account`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      address: 'Musterstraße 1, 12345 Musterstadt',
      phone: '+49 123 456789',
      emergencyContactLastName: 'Mustermann',
      emergencyContactFirstName: 'Erika',
      emergencyContactPhone: '+49 987 654321',
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.address, 'Musterstraße 1, 12345 Musterstadt');
  assert.equal(patched.phone, '+49 123 456789');
  assert.equal(patched.emergencyContactLastName, 'Mustermann');
  assert.equal(patched.emergencyContactFirstName, 'Erika');
  assert.equal(patched.emergencyContactPhone, '+49 987 654321');

  const { rows } = await query('SELECT address_enc, emergency_contact_last_name_enc FROM users WHERE id = $1', [userId]);
  assert.notEqual(rows[0].address_enc.toString('utf8'), 'Musterstraße 1, 12345 Musterstadt');
  assert.notEqual(rows[0].emergency_contact_last_name_enc.toString('utf8'), 'Mustermann');
```
(Read the test's exact current body first and merge these additions into its existing structure rather than duplicating the whole test — the existing `pronomen`-related lines in this same test block will be removed in Task 6, not here; leave them alone for now.)

- [ ] **Step 10: Run the affected tests**

Run: `node --test tests/integration/accounts.test.js tests/integration/members.test.js tests/integration/invitations.test.js --test-concurrency=1`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add db/migrations/016_split_emergency_contact_fields.sql backend/accountFields.js backend/accounts/repository.js backend/members/repository.js backend/invitations/repository.js backend/auth/invite.js backend/members/routes.js db/groupDefaults.js tests/integration/accounts.test.js
git commit -m "feat: split Notfallkontakt into Name/Vorname/Telefonnummer"
```

---

### Task 5: Notfallkontakt-Split — Frontend

**Files:**
- Modify: `frontend/account.html`
- Modify: `frontend/admin/members.html`
- Modify: `frontend/admin/groups.html`

**Interfaces:**
- Consumes: `PATCH /account`/`PATCH /members/:id`/`POST /members/invite` now accept `emergencyContactLastName`/`emergencyContactFirstName`/`emergencyContactPhone` instead of `emergencyContact`.

- [ ] **Step 1: `frontend/account.html`**

Replace the single Notfallkontakt field:
```html
      <label for="emergencyContact">Notfallkontakt <span class="sealed">Verschlüsselt</span></label>
      <input id="emergencyContact" name="emergencyContact" type="text">
```
with:
```html
      <label for="emergencyContactLastName">Notfallkontakt: Name <span class="sealed">Verschlüsselt</span></label>
      <input id="emergencyContactLastName" name="emergencyContactLastName" type="text">
      <label for="emergencyContactFirstName">Notfallkontakt: Vorname <span class="sealed">Verschlüsselt</span></label>
      <input id="emergencyContactFirstName" name="emergencyContactFirstName" type="text">
      <label for="emergencyContactPhone">Notfallkontakt: Telefonnummer <span class="sealed">Verschlüsselt</span></label>
      <input id="emergencyContactPhone" name="emergencyContactPhone" type="text">
```
Change the field-population loop (already modified by Task 3):
```javascript
    for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen']) {
```
to:
```javascript
    for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'pronomen']) {
```

- [ ] **Step 2: `frontend/admin/members.html`**

Read the current file (as modified by Task 3). Update `ACCOUNT_FIELD_LABELS`:
```javascript
const ACCOUNT_FIELD_LABELS = {
  address: 'Adresse', birthdate: 'Geburtsdatum', phone: 'Telefon',
  emergencyContact: 'Notfallkontakt', medicalNotes: 'Gesundheitshinweise',
  pronomen: 'Pronomen',
};
```
to:
```javascript
const ACCOUNT_FIELD_LABELS = {
  address: 'Adresse', birthdate: 'Geburtsdatum', phone: 'Telefon',
  emergencyContactLastName: 'Notfallkontakt: Name', emergencyContactFirstName: 'Notfallkontakt: Vorname', emergencyContactPhone: 'Notfallkontakt: Telefonnummer',
  medicalNotes: 'Gesundheitshinweise', pronomen: 'Pronomen',
};
```
Both `buildFieldInputs` (invite form) and `buildDetailFieldInputs` (member detail) iterate over these keys generically already (`myAccountFields.filter(...)` and `ALL_FIELD_KEYS = Object.keys(ACCOUNT_FIELD_LABELS)` respectively) — no further code change needed in either function, the 3 new keys flow through automatically once the labels object above is updated. Confirm this by reading both functions after making the change above.

- [ ] **Step 3: `frontend/admin/groups.html`**

Read the current file (as modified in the previous plan for the group-edit dialog). Update the account-fields checkbox list:
```html
        <div class="checkbox-group" id="field-checkboxes">
          <label><input type="checkbox" value="address"> Adresse</label>
          <label><input type="checkbox" value="birthdate"> Geburtsdatum</label>
          <label><input type="checkbox" value="phone"> Telefon</label>
          <label><input type="checkbox" value="emergencyContact"> Notfallkontakt</label>
          <label><input type="checkbox" value="medicalNotes"> Gesundheitshinweise</label>
          <label><input type="checkbox" value="pronomen"> Pronomen</label>
          <label><input type="checkbox" value="group"> Gruppe</label>
        </div>
```
to:
```html
        <div class="checkbox-group" id="field-checkboxes">
          <label><input type="checkbox" value="address"> Adresse</label>
          <label><input type="checkbox" value="birthdate"> Geburtsdatum</label>
          <label><input type="checkbox" value="phone"> Telefon</label>
          <label><input type="checkbox" value="emergencyContactLastName"> Notfallkontakt: Name</label>
          <label><input type="checkbox" value="emergencyContactFirstName"> Notfallkontakt: Vorname</label>
          <label><input type="checkbox" value="emergencyContactPhone"> Notfallkontakt: Telefonnummer</label>
          <label><input type="checkbox" value="medicalNotes"> Gesundheitshinweise</label>
          <label><input type="checkbox" value="pronomen"> Pronomen</label>
          <label><input type="checkbox" value="group"> Gruppe</label>
        </div>
```
(The pronomen checkbox is removed in Task 6, not here — leave it for now.)

- [ ] **Step 4: Manual verification**

Start the dev server, use the Browser tool: navigate to `/account.html`, confirm the 3 Notfallkontakt fields show, save a value in each, reload and confirm they persisted. Navigate to `/admin/groups.html` as admin, open a group's edit dialog, confirm the 3 new checkboxes appear in place of the old single one. Navigate to `/admin/members.html`, confirm the invite form and a member's detail view both show the 3 fields (if the acting admin's group has them enabled). Screenshot as evidence.

- [ ] **Step 5: Commit**

```bash
git add frontend/account.html frontend/admin/members.html frontend/admin/groups.html
git commit -m "feat: split Notfallkontakt fields in account, member, and group forms"
```

---

### Task 6: Pronomen entfernen

**Files:**
- Create: `db/migrations/017_remove_pronomen_field.sql`
- Modify: `backend/accountFields.js`
- Modify: `backend/accounts/repository.js`
- Modify: `backend/members/repository.js`
- Modify: `backend/invitations/repository.js`
- Modify: `backend/auth/invite.js`
- Modify: `backend/members/routes.js`
- Modify: `db/groupDefaults.js`
- Modify: `frontend/account.html`
- Modify: `frontend/admin/groups.html`
- Modify: `frontend/admin/members.html`
- Modify: `tests/integration/accounts.test.js`
- Modify: `tests/integration/schema-users.test.js`

**Interfaces:**
- Removes `pronomen`/`pronomen_enc` and the `'pronomen'` key from `ACCOUNT_FIELD_KEYS` everywhere.

- [ ] **Step 1: Write the migration**

Create `db/migrations/017_remove_pronomen_field.sql`:

```sql
ALTER TABLE users DROP COLUMN pronomen_enc;
ALTER TABLE invitations DROP COLUMN pronomen_enc;
UPDATE groups SET account_fields = account_fields - 'pronomen' WHERE account_fields ? 'pronomen';
```

- [ ] **Step 2: `backend/accountFields.js`**

```javascript
export const ACCOUNT_FIELD_KEYS = ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'group'];
```

- [ ] **Step 3: `backend/accounts/repository.js`**

Remove the `pronomen: decryptField(row.pronomen_enc),` line from `decryptAccount`. Remove `users.pronomen_enc` from `SELECT_COLUMNS`. In `updateAccount`, remove the `pronomen_enc = COALESCE($N, pronomen_enc),` SET clause and its corresponding `fields.pronomen !== undefined ? encryptField(fields.pronomen) : null,` param — renumber every placeholder after it down by one.

- [ ] **Step 4: `backend/members/repository.js`**

Apply the identical removal to `SELECT_COLUMNS`, `decryptMember`, and `updateMember`.

- [ ] **Step 5: `backend/invitations/repository.js`**

Apply the identical removal to `SELECT_COLUMNS`, `decryptInvitation`, and `createInvitation` (both its parameter destructure and its INSERT statement's column list/params).

- [ ] **Step 6: `backend/auth/invite.js`**

Remove `pronomen_enc` from the redemption INSERT's column list and the `(SELECT pronomen_enc FROM invitations WHERE id = $5)` subquery.

- [ ] **Step 7: `backend/members/routes.js`**

Read the current file. If the invite handler's `createInvitation({...})` call has an explicit `pronomen: rest.pronomen,` line, remove it (if it instead relies on `...rest` spreading implicitly, no change is needed there — but confirm which pattern this file actually uses by reading it, since Task 4 Step 7 already established this file mostly passes fields through via `rest`).

- [ ] **Step 8: `db/groupDefaults.js`**

Remove `'pronomen'` from the `admin` and `orga` entries' `accountFields` arrays.

- [ ] **Step 9: `frontend/account.html`**

Remove:
```html
      <label for="pronomen">Pronomen <span class="sealed">Verschlüsselt</span></label>
      <input id="pronomen" name="pronomen" type="text">
```
Remove `'pronomen'` from the field-population loop's array.

- [ ] **Step 10: `frontend/admin/groups.html`**

Remove `<label><input type="checkbox" value="pronomen"> Pronomen</label>` from the field-checkboxes group.

- [ ] **Step 11: `frontend/admin/members.html`**

Remove the `pronomen: 'Pronomen',` entry from `ACCOUNT_FIELD_LABELS`.

- [ ] **Step 12: `tests/integration/accounts.test.js`**

Read the current file (as modified by Task 4). Find the test `'PATCH /account encrypts and returns sensitive fields; unspecified fields survive a partial update'` — remove every line referencing `pronomen`/`pronomen_enc` from its PATCH body, assertions, and the raw-SQL verification query (the `emergencyContact*` additions from Task 4 Step 9 stay).

- [ ] **Step 13: `tests/integration/schema-users.test.js`**

Read the current file (as modified by Task 2). Remove the test `'admin and orga groups have pronomen in their account_fields after migration'` entirely (lines ~37-42) — it asserts behavior this task deliberately reverses. Add a replacement schema-assertion test, matching this file's established style (the `users.nsc_data column no longer exists` / `users.name column no longer exists` pattern from Task 2 Step 1):

```javascript
test('users.pronomen_enc column no longer exists after migration', async () => {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pronomen_enc'`
  );
  assert.equal(rows.length, 0);
});
```

- [ ] **Step 14: Manual verification**

Start the dev server, use the Browser tool: navigate to `/account.html`, `/admin/groups.html`, `/admin/members.html` and confirm Pronomen no longer appears anywhere. Screenshot as evidence.

- [ ] **Step 15: Commit**

```bash
git add db/migrations/017_remove_pronomen_field.sql backend/accountFields.js backend/accounts/repository.js backend/members/repository.js backend/invitations/repository.js backend/auth/invite.js backend/members/routes.js db/groupDefaults.js frontend/account.html frontend/admin/groups.html frontend/admin/members.html tests/integration/accounts.test.js tests/integration/schema-users.test.js
git commit -m "feat: remove Pronomen field entirely"
```

---

### Task 7: Full test suite

**Files:** None (verification-only task).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test in the project passes. This is the mandatory final gate — do not skip or substitute a scoped subset. If anything fails, diagnose and fix (the fix might be in this plan's own code, or might reveal a genuine gap missed by the file lists above — re-verify against the actual current codebase rather than assuming the plan's file lists were exhaustive).

- [ ] **Step 2: Commit if Step 1 required fixes**

If Step 1 was already green, skip this step. Otherwise:
```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

## Self-Review Notes

- Spec coverage: covers Teil 2 of `2026-08-30-mitgliederfelder-sichtbarkeit-uploads-design.md` in full (all 3 sub-items: name split, Notfallkontakt split, Pronomen removal).
- Read-only display consumers (`admin/members.html`'s member-list table, `admin/checkin.html`'s participant list, `admin/members.html`'s invited-list mapping) require ZERO changes anywhere in this plan — verified by design (every repository function keeps returning a computed `name` field via `displayName()`), not just assumed.
- Data-loss consequence: the Notfallkontakt split (Task 4) has no automatic migration path for existing data — this is called out explicitly in the plan's Global Constraints and must be communicated to the user before merge, not silently absorbed.
- Test coverage gap closed, not just carried forward: the old `pronomen` round-trip encryption test (removed in Task 6) is replaced by an equivalent-shaped new test for the emergency-contact fields (added in Task 4, since that's genuinely untested territory today) — the net test coverage for "does PATCH /account actually encrypt a sensitive field" does not regress.
- Type/interface consistency: `displayName()`/`splitFullName()` signatures are used identically everywhere they're called (Task 1 Steps 4-10); `ACCOUNT_FIELD_KEYS` additions/removals (Tasks 4, 6) are mirrored exactly in `db/groupDefaults.js` and the corresponding migration's retroactive grant/revoke, matching the established pattern from every prior group-permission migration in this project's history.
