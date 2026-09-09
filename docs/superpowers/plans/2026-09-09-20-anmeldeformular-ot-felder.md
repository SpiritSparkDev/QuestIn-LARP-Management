# Anmeldeformular OT-Felder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `conTage`, `accommodation`, `craftOffer`, `travelMethod`, `dataSharingOptOut`, `photoOptOut` from account-wide fields (one value per user) to per-registration fields (one value per Con-Anmeldung) — each event registration gets its own answers, editable after submission with an email notification to event orga/hilfs_orga and system admin/moderator.

**Architecture:** 6 new encrypted columns move from `users`/`invitations` onto `registrations` (same `bytea` + AES-GCM pattern already used everywhere, no new storage concept). A new self-contained `backend/registrationFields.js` mirrors `backend/accountFields.js`'s shape for these 6 keys. The existing `group.accountFields` permission array stays the single source of truth for "who can see/edit which OT field," now spanning both scopes. A new `PUT /events/:id/registrations/:userId/ot-fields` route (owner or `'mitglieder'`-menu staff) handles edits and fires an email notification through the existing `nodemailer`-based mailer.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step, `nodemailer` (already a dependency) for the new notification email.

**Spec:** `docs/superpowers/specs/2026-09-09-anmeldeformular-ot-felder-design.md`

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step.
- The `users`/`invitations` column drop and every backend consumer of those columns must be fixed in the SAME task as the drop (same lesson as Teil 1/Teil 2) — Task 1 below covers `accounts/repository.js`, `members/repository.js`, `members/routes.js`, `invitations/repository.js`, `auth/invite.js`, and `groups/routes.js` together with the migration.
- Bestandsdaten für die 6 Felder werden verworfen (kein Backfill) — jede Registrierung startet mit leeren Werten.
- The new `PUT /events/:id/registrations/:userId/ot-fields` route allows the registration owner OR a user whose `group.visibleMenus` includes `'mitglieder'` — never anyone else.
- Every successful call to that route triggers the notification email (including staff editing on a participant's behalf — no special-casing).
- Every existing test must still pass; verify with each task's specified scope before the final full-suite gate.
- Verify visually via Claude Browser tools for every page touched.

---

### Task 1: Datenmodell + Konto-/Einladungs-Konsumenten

**Files:**
- Create: `db/migrations/030_anmeldung_ot_felder.sql`
- Create: `backend/registrationFields.js`
- Modify: `backend/accountFields.js`
- Modify: `backend/accounts/repository.js`
- Modify: `backend/members/repository.js`
- Modify: `backend/members/routes.js`
- Modify: `backend/invitations/repository.js`
- Modify: `backend/auth/invite.js`
- Modify: `backend/groups/routes.js`
- Modify: `tests/integration/accounts.test.js`

**Interfaces:**
- Produces: `backend/registrationFields.js` exporting `REGISTRATION_FIELD_KEYS` (array of 6 keys), `ENCRYPTED_REGISTRATION_FIELD_COLUMNS` (key → column name map), `decryptEncryptedRegistrationFields(row)`, `encryptRegistrationFieldValues(fields)` — same shape as `accountFields.js`'s equivalents, consumed by Task 2.
- Produces: `backend/accountFields.js`'s `ACCOUNT_FIELD_KEYS`/`ENCRYPTED_ACCOUNT_FIELD_COLUMNS` shrunk to the 8 true account fields (address, birthdate, phone, emergencyContactLastName/FirstName/Phone, medicalNotes, group).

- [ ] **Step 1: Write the migration**

Create `db/migrations/030_anmeldung_ot_felder.sql`:

```sql
-- 1. New encrypted columns on registrations for the 6 fields moving here
--    from account-wide storage (nullable, optional -- no backfill, existing
--    account-level values are discarded per the design decision).
ALTER TABLE registrations ADD COLUMN con_tage_enc bytea;
ALTER TABLE registrations ADD COLUMN accommodation_enc bytea;
ALTER TABLE registrations ADD COLUMN craft_offer_enc bytea;
ALTER TABLE registrations ADD COLUMN travel_method_enc bytea;
ALTER TABLE registrations ADD COLUMN data_sharing_opt_out_enc bytea;
ALTER TABLE registrations ADD COLUMN photo_opt_out_enc bytea;

-- 2. Drop the old account-wide columns -- no backfill, values discarded.
ALTER TABLE users
  DROP COLUMN con_tage_enc,
  DROP COLUMN accommodation_enc,
  DROP COLUMN craft_offer_enc,
  DROP COLUMN travel_method_enc,
  DROP COLUMN data_sharing_opt_out_enc,
  DROP COLUMN photo_opt_out_enc;

ALTER TABLE invitations
  DROP COLUMN con_tage_enc,
  DROP COLUMN accommodation_enc,
  DROP COLUMN craft_offer_enc,
  DROP COLUMN travel_method_enc,
  DROP COLUMN data_sharing_opt_out_enc,
  DROP COLUMN photo_opt_out_enc;
```

- [ ] **Step 2: Create `backend/registrationFields.js`**

```javascript
import { encryptField, decryptField } from './crypto/fieldCrypto.js';

// The 6 event-scoped OT fields living on registrations (moved off the
// account in Teil 3 of the user-testing feedback package) -- same
// encrypted-column pattern as accountFields.js, gated by the same
// group.accountFields permission list (see
// registrations/repository.js's listParticipantsForEvent).
export const REGISTRATION_FIELD_KEYS = [
  'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut',
];

export const ENCRYPTED_REGISTRATION_FIELD_COLUMNS = {
  conTage: 'con_tage_enc',
  accommodation: 'accommodation_enc',
  craftOffer: 'craft_offer_enc',
  travelMethod: 'travel_method_enc',
  dataSharingOptOut: 'data_sharing_opt_out_enc',
  photoOptOut: 'photo_opt_out_enc',
};

const ENCRYPTED_FIELD_KEYS = Object.keys(ENCRYPTED_REGISTRATION_FIELD_COLUMNS);

// Decrypts every registration OT field out of a row that carries the
// *_enc columns above (aliased or not), keyed back to their camelCase
// field name.
export function decryptEncryptedRegistrationFields(row) {
  const result = {};
  for (const key of ENCRYPTED_FIELD_KEYS) {
    result[key] = decryptField(row[ENCRYPTED_REGISTRATION_FIELD_COLUMNS[key]]);
  }
  return result;
}

// Encrypts whichever of the 6 fields are present in `fields`, always in
// ENCRYPTED_REGISTRATION_FIELD_COLUMNS order -- callers append the result
// to their own COALESCE UPDATE/INSERT param list.
export function encryptRegistrationFieldValues(fields) {
  return ENCRYPTED_FIELD_KEYS.map((key) => (fields[key] !== undefined ? encryptField(fields[key]) : null));
}
```

- [ ] **Step 3: Shrink `backend/accountFields.js`**

```javascript
import { encryptField, decryptField } from './crypto/fieldCrypto.js';

export const ACCOUNT_FIELD_KEYS = [
  'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone',
  'medicalNotes', 'group',
];

// Encrypted-at-rest member (OT) fields, mapped to their column. 'group' is
// deliberately excluded: it's an access-control field, not personal data.
export const ENCRYPTED_ACCOUNT_FIELD_COLUMNS = {
  address: 'address_enc',
  birthdate: 'birthdate_enc',
  phone: 'phone_enc',
  emergencyContactLastName: 'emergency_contact_last_name_enc',
  emergencyContactFirstName: 'emergency_contact_first_name_enc',
  emergencyContactPhone: 'emergency_contact_phone_enc',
  medicalNotes: 'medical_notes_enc',
};

const ENCRYPTED_FIELD_KEYS = Object.keys(ENCRYPTED_ACCOUNT_FIELD_COLUMNS);

// Decrypts every OT field out of a row that carries the *_enc columns above
// (aliased or not), keyed back to their camelCase field name.
export function decryptEncryptedAccountFields(row) {
  const result = {};
  for (const key of ENCRYPTED_FIELD_KEYS) {
    result[key] = decryptField(row[ENCRYPTED_ACCOUNT_FIELD_COLUMNS[key]]);
  }
  return result;
}

// Encrypts whichever of the 7 OT fields are present in `fields`, always in
// ENCRYPTED_ACCOUNT_FIELD_COLUMNS order -- callers append the result to their
// own COALESCE UPDATE param list, after their entity-specific columns.
export function encryptAccountFieldValues(fields) {
  return ENCRYPTED_FIELD_KEYS.map((key) => (fields[key] !== undefined ? encryptField(fields[key]) : null));
}
```

- [ ] **Step 4: Fix `backend/accounts/repository.js`**

```javascript
import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { decryptEncryptedAccountFields, encryptAccountFieldValues } from '../accountFields.js';

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
    ...decryptEncryptedAccountFields(row),
  };
}

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.hotkeys,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc,
  groups.key AS group_key, groups.name AS group_name, groups.visible_menus, groups.can_edit_characters, groups.account_fields, groups.can_override_checkin_status
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
       first_name = COALESCE($2, first_name),
       last_name = COALESCE($3, last_name),
       nickname = COALESCE($4, nickname),
       hotkeys = COALESCE($5, hotkeys),
       address_enc = COALESCE($6, address_enc),
       birthdate_enc = COALESCE($7, birthdate_enc),
       phone_enc = COALESCE($8, phone_enc),
       emergency_contact_last_name_enc = COALESCE($9, emergency_contact_last_name_enc),
       emergency_contact_first_name_enc = COALESCE($10, emergency_contact_first_name_enc),
       emergency_contact_phone_enc = COALESCE($11, emergency_contact_phone_enc),
       medical_notes_enc = COALESCE($12, medical_notes_enc)
     WHERE id = $1
     RETURNING id`,
    [
      userId,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      fields.hotkeys !== undefined ? JSON.stringify(fields.hotkeys) : null,
      ...encryptAccountFieldValues(fields),
    ]
  );
  if (rows.length === 0) return null;
  return getAccount(userId);
}
```

- [ ] **Step 5: Fix `backend/members/repository.js`**

Only `SELECT_COLUMNS` and `updateMember`'s UPDATE statement change — `getMember`'s character-listing query and everything else stays exactly as-is:

```javascript
import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';
import { decryptEncryptedAccountFields, encryptAccountFieldValues } from '../accountFields.js';

const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.deactivated_at,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc,
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
    ...decryptEncryptedAccountFields(row),
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
  const { rows } = await query(
    `UPDATE users SET
       group_id = COALESCE($2, group_id),
       first_name = COALESCE($3, first_name),
       last_name = COALESCE($4, last_name),
       nickname = COALESCE($5, nickname),
       address_enc = COALESCE($6, address_enc),
       birthdate_enc = COALESCE($7, birthdate_enc),
       phone_enc = COALESCE($8, phone_enc),
       emergency_contact_last_name_enc = COALESCE($9, emergency_contact_last_name_enc),
       emergency_contact_first_name_enc = COALESCE($10, emergency_contact_first_name_enc),
       emergency_contact_phone_enc = COALESCE($11, emergency_contact_phone_enc),
       medical_notes_enc = COALESCE($12, medical_notes_enc)
     WHERE id = $1
     RETURNING id`,
    [
      id,
      fields.group ?? null,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.nickname ?? null,
      ...encryptAccountFieldValues(fields),
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
```

- [ ] **Step 6: Fix `backend/members/routes.js`'s invite handler**

In the `POST /members/invite` handler, remove the 6 lines forwarding the removed fields to `createInvitation`:

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

(Everything else in the file — `filterToAllowedFields`, both route handlers' surrounding logic — is unchanged.)

- [ ] **Step 7: Fix `backend/invitations/repository.js`**

```javascript
import crypto from 'node:crypto';
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
import { displayName } from '../displayName.js';

const SELECT_COLUMNS = `
  id, token, email, first_name, last_name, nickname, group_id,
  address_enc, birthdate_enc, phone_enc, emergency_contact_last_name_enc, emergency_contact_first_name_enc, emergency_contact_phone_enc, medical_notes_enc,
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
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContactLastName: decryptField(row.emergency_contact_last_name_enc),
    emergencyContactFirstName: decryptField(row.emergency_contact_first_name_enc),
    emergencyContactPhone: decryptField(row.emergency_contact_phone_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    redeemedAt: row.redeemed_at,
  };
}

export async function createInvitation({ email, firstName, lastName, nickname, groupId, invitedBy, eventId, address, birthdate, phone, emergencyContactLastName, emergencyContactFirstName, emergencyContactPhone, medicalNotes, ttlDays = 3 }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const { rows } = await query(
    `INSERT INTO invitations (token, email, first_name, last_name, nickname, group_id, address_enc, birthdate_enc, phone_enc, emergency_contact_last_name_enc, emergency_contact_first_name_enc, emergency_contact_phone_enc, medical_notes_enc, event_id, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${SELECT_COLUMNS}`,
    [
      token, email, firstName, lastName, nickname ?? null, groupId,
      address !== undefined ? encryptField(address) : null,
      birthdate !== undefined ? encryptField(birthdate) : null,
      phone !== undefined ? encryptField(phone) : null,
      emergencyContactLastName !== undefined ? encryptField(emergencyContactLastName) : null,
      emergencyContactFirstName !== undefined ? encryptField(emergencyContactFirstName) : null,
      emergencyContactPhone !== undefined ? encryptField(emergencyContactPhone) : null,
      medicalNotes !== undefined ? encryptField(medicalNotes) : null,
      eventId ?? null,
      invitedBy, expiresAt,
    ]
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

// Accepts an optional transaction client so redemption can mark the
// invitation redeemed in the same atomic transaction as user creation.
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

// Used to render "Benachrichtigt" rows in an event's participant list: an
// invitation for this event with no matching registration yet.
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

- [ ] **Step 8: Fix `backend/auth/invite.js`**

Change the `INSERT INTO users (...)` inside the redeem handler's transaction — drop the 6 columns and their `(SELECT ..._enc FROM invitations WHERE id = $7)` subqueries:

```javascript
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, group_id, first_name, last_name, nickname, email_verified, address_enc, birthdate_enc, phone_enc, emergency_contact_last_name_enc, emergency_contact_first_name_enc, emergency_contact_phone_enc, medical_notes_enc)
         VALUES ($1, $2, $3, $4, $5, $6, true,
           (SELECT address_enc FROM invitations WHERE id = $7),
           (SELECT birthdate_enc FROM invitations WHERE id = $7),
           (SELECT phone_enc FROM invitations WHERE id = $7),
           (SELECT emergency_contact_last_name_enc FROM invitations WHERE id = $7),
           (SELECT emergency_contact_first_name_enc FROM invitations WHERE id = $7),
           (SELECT emergency_contact_phone_enc FROM invitations WHERE id = $7),
           (SELECT medical_notes_enc FROM invitations WHERE id = $7))
         RETURNING id`,
        [invitation.email, passwordHash, invitation.groupId, invitation.firstName, invitation.lastName, invitation.nickname ?? null, invitation.id]
      );
```

(The rest of the file — transaction wrapper, `markRedeemed`, session creation — is unchanged.)

- [ ] **Step 9: Fix `backend/groups/routes.js`'s field-list validator**

`group.accountFields` still gates the 6 registration-scoped fields too (5.4 of the spec), so the validator must accept both key sets, not just the shrunk `ACCOUNT_FIELD_KEYS`:

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listGroups, getGroup, createGroup, updateGroup } from './repository.js';
import { ACCOUNT_FIELD_KEYS } from '../accountFields.js';
import { REGISTRATION_FIELD_KEYS } from '../registrationFields.js';

const MENU_KEYS = ['konto', 'charaktere', 'con-anmeldungen', 'mitglieder', 'events', 'checkin'];
const KEY_PATTERN = /^[a-z0-9_]+$/;
const ALLOWED_ACCOUNT_FIELD_KEYS = [...ACCOUNT_FIELD_KEYS, ...REGISTRATION_FIELD_KEYS];

function isValidMenuList(value) {
  return Array.isArray(value) && value.every((v) => MENU_KEYS.includes(v));
}

function isValidFieldList(value) {
  return Array.isArray(value) && value.every((v) => ALLOWED_ACCOUNT_FIELD_KEYS.includes(v));
}
```

Both error-message lines further down that currently read
`` `accountFields must be an array containing only: ${ACCOUNT_FIELD_KEYS.join(', ')}` ``
change to use `ALLOWED_ACCOUNT_FIELD_KEYS.join(', ')` instead. Nothing else in the file changes.

- [ ] **Step 10: Fix `tests/integration/accounts.test.js`**

The `'PATCH /account encrypts and returns sensitive fields; unspecified fields survive a partial update'` test currently sends and asserts the 6 removed fields. Update it to only cover the 8 remaining account fields:

```javascript
test('PATCH /account encrypts and returns sensitive fields; unspecified fields survive a partial update', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await registerLoginAndGetCookie(port);

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
    assert.equal(patched.name, 'Account Test');
    assert.equal(patched.emergencyContactLastName, 'Mustermann');
    assert.equal(patched.emergencyContactFirstName, 'Erika');
    assert.equal(patched.emergencyContactPhone, '+49 987 654321');

    const { rows } = await query('SELECT address_enc, emergency_contact_last_name_enc FROM users WHERE id = $1', [userId]);
    assert.notEqual(rows[0].address_enc.toString('utf8'), 'Musterstraße 1, 12345 Musterstadt');
    assert.notEqual(rows[0].emergency_contact_last_name_enc.toString('utf8'), 'Mustermann');

    const secondPatchRes = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ medicalNotes: 'keine' }),
    });
    const secondPatched = await secondPatchRes.json();
    assert.equal(secondPatched.address, 'Musterstraße 1, 12345 Musterstadt');
    assert.equal(secondPatched.medicalNotes, 'keine');
  });
});
```

Every other test in the file is unaffected.

- [ ] **Step 11: Run the scoped tests**

Run: `node --test tests/integration/accounts.test.js tests/integration/members.test.js tests/integration/invitations.test.js tests/integration/checkin.test.js tests/unit/formFields.test.js`
Expected: all PASS.

- [ ] **Step 12: Commit**

```bash
git add db/migrations/030_anmeldung_ot_felder.sql backend/registrationFields.js backend/accountFields.js backend/accounts/repository.js backend/members/repository.js backend/members/routes.js backend/invitations/repository.js backend/auth/invite.js backend/groups/routes.js tests/integration/accounts.test.js
git commit -m "feat: move conTage/accommodation/craftOffer/travelMethod/dataSharingOptOut/photoOptOut off the account (registrations gain the columns instead)"
```

---

### Task 2: Registrierungs-Backend — Felder, Bearbeiten-Route, Benachrichtigung, Sichtbarkeit

**Files:**
- Modify: `backend/registrations/repository.js`
- Modify: `backend/registrations/routes.js`
- Modify: `backend/auth/mailer.js`
- Modify: `tests/integration/registrations.test.js`
- Modify: `tests/integration/checkin.test.js`

**Interfaces:**
- Consumes: `REGISTRATION_FIELD_KEYS`, `ENCRYPTED_REGISTRATION_FIELD_COLUMNS`, `decryptEncryptedRegistrationFields`, `encryptRegistrationFieldValues` from Task 1's `backend/registrationFields.js`.
- Produces: `registerForEvent(userId, eventId, conRole, characterId, otFields, requestingUser)` (new `otFields` param, inserted before `requestingUser`). Produces: `updateRegistrationOtFields(eventId, userId, otFields)` — throws `REGISTRATION_NOT_FOUND`. Produces: `resolveOtFieldsChangeRecipients(eventId)` → array of email strings. Produces: `notifyRegistrationOtFieldsChanged(eventId, userId)` — never throws, logs and swallows delivery failures internally. Produces: `sendRegistrationOtFieldsChangedEmail(to, { userName, eventName })` in `backend/auth/mailer.js`.

- [ ] **Step 1: Add `otFields` to `registerForEvent` and the register route**

In `backend/registrations/repository.js`, add the import and change `registerForEvent`'s signature and INSERT:

```javascript
import { ENCRYPTED_REGISTRATION_FIELD_COLUMNS, decryptEncryptedRegistrationFields, encryptRegistrationFieldValues } from '../registrationFields.js';
```

```javascript
export async function registerForEvent(userId, eventId, conRole, characterId, otFields, requestingUser) {
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
    const err = new Error('registration is only open for the currently active event');
    err.code = 'EVENT_NOT_ACTIVE';
    throw err;
  }

  const resolvedCharacterId = await resolveCharacterId(userId, conRole, characterId);

  try {
    const { rows } = await query(
      `INSERT INTO registrations (user_id, event_id, con_role, character_id, con_tage_enc, accommodation_enc, craft_offer_enc, travel_method_enc, data_sharing_opt_out_enc, photo_opt_out_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at`,
      [userId, eventId, conRole, resolvedCharacterId, ...encryptRegistrationFieldValues(otFields ?? {})]
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

In `backend/registrations/routes.js`, pass `body.otFields` through:

```javascript
router.post('/events/:id/register', requireAuth(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await registerForEvent(user.id, params.id, body.conRole, body.characterId, body.otFields, user);
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
    if (err.code === 'CHARACTER_NOT_FOUND') return { status: 404, body: { error: err.message } };
    if (err.code === 'CHARACTER_FORBIDDEN') return { status: 403, body: { error: err.message } };
    throw err;
  }
}));
```

- [ ] **Step 2: Include the 6 fields in `listRegistrationsForUser`**

```javascript
export async function listRegistrationsForUser(userId) {
  const { rows } = await query(
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.checked_in_at, r.checked_out_at,
            r.con_tage_enc, r.accommodation_enc, r.craft_offer_enc, r.travel_method_enc, r.data_sharing_opt_out_enc, r.photo_opt_out_enc
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
    ...decryptEncryptedRegistrationFields(r),
  }));
}
```

- [ ] **Step 3: Add `updateRegistrationOtFields`, recipient resolution, and the notify helper**

Add near the bottom of `backend/registrations/repository.js` (after the existing exports, before `test.after`-irrelevant since this is a source file not a test):

```javascript
import { sendRegistrationOtFieldsChangedEmail } from '../auth/mailer.js';
import { logger } from '../logger.js';
```

```javascript
export async function updateRegistrationOtFields(eventId, userId, otFields) {
  const { rows } = await query(
    `UPDATE registrations SET
       con_tage_enc = COALESCE($3, con_tage_enc),
       accommodation_enc = COALESCE($4, accommodation_enc),
       craft_offer_enc = COALESCE($5, craft_offer_enc),
       travel_method_enc = COALESCE($6, travel_method_enc),
       data_sharing_opt_out_enc = COALESCE($7, data_sharing_opt_out_enc),
       photo_opt_out_enc = COALESCE($8, photo_opt_out_enc)
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, status, con_role, character_id, checked_in_at, checked_out_at,
               con_tage_enc, accommodation_enc, craft_offer_enc, travel_method_enc, data_sharing_opt_out_enc, photo_opt_out_enc`,
    [eventId, userId, ...encryptRegistrationFieldValues(otFields ?? {})]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  const r = rows[0];
  return {
    userId: r.user_id,
    eventId: r.event_id,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    ...decryptEncryptedRegistrationFields(r),
  };
}

// Recipients for the "a registration's OT fields changed" notification:
// every user holding an orga/hilfs_orga registration for THIS event, plus
// every system admin/moderator, regardless of event. A plain UNION (not a
// JOIN + OR) so each half stays simple to read and test independently.
export async function resolveOtFieldsChangeRecipients(eventId) {
  const { rows } = await query(
    `SELECT email FROM (
       SELECT u.email FROM users u
       JOIN registrations r ON r.user_id = u.id
       WHERE r.event_id = $1 AND r.con_role IN ('orga', 'hilfs_orga')
       UNION
       SELECT u.email FROM users u
       JOIN groups g ON g.id = u.group_id
       WHERE g.key IN ('admin', 'moderator')
     ) recipients`,
    [eventId]
  );
  return rows.map((r) => r.email);
}

// Never throws -- a delivery failure to one or all recipients must not turn
// a successful field save into a 500. Each recipient gets its own
// try/catch so one bad address doesn't stop the rest.
export async function notifyRegistrationOtFieldsChanged(eventId, userId) {
  const event = await getEvent(eventId);
  const { rows: userRows } = await query(
    'SELECT first_name, last_name, nickname FROM users WHERE id = $1',
    [userId]
  );
  const userName = userRows[0]
    ? displayName({ firstName: userRows[0].first_name, lastName: userRows[0].last_name, nickname: userRows[0].nickname })
    : 'Unbekannt';
  const eventName = event?.name ?? 'Unbekanntes Event';
  const recipients = await resolveOtFieldsChangeRecipients(eventId);
  for (const to of recipients) {
    try {
      await sendRegistrationOtFieldsChangedEmail(to, { userName, eventName });
    } catch (err) {
      logger.error('failed to send OT-fields-changed notification', { error: err.message, to, eventId, userId });
    }
  }
}
```

- [ ] **Step 4: Add `sendRegistrationOtFieldsChangedEmail` to `backend/auth/mailer.js`**

Append to the file (same shape as the existing `sendInvitationEmail`):

```javascript
export async function sendRegistrationOtFieldsChangedEmail(to, { userName, eventName }) {
  const { transporter, from } = await getTransporterAndFrom();
  return transporter.sendMail({
    to,
    from,
    subject: `Anmeldungsdaten geändert: ${eventName}`,
    text: `${userName} hat die Con-Tage/Unterbringung/Handwerk/Anreise/Opt-Out-Angaben der eigenen Anmeldung für "${eventName}" nachträglich geändert.`,
  });
}
```

- [ ] **Step 5: Add the `PUT /events/:id/registrations/:userId/ot-fields` route**

In `backend/registrations/routes.js`, import the two new repository functions and add the route (anywhere after the existing imports/routes, e.g. right after the con-role promotion route):

```javascript
import {
  registerForEvent,
  setConRole,
  unregisterFromEvent,
  listParticipantsForEvent,
  listRegistrationsForUser,
  checkIn,
  checkOut,
  approveRegistration,
  cancelRegistration,
  setStatus,
  getScanLookup,
  updateRegistrationOtFields,
  notifyRegistrationOtFieldsChanged,
} from './repository.js';
```

```javascript
router.put('/events/:id/registrations/:userId/ot-fields', requireAuth(async ({ req, params, user }) => {
  const isOwner = params.userId === user.id;
  const isStaff = user.group.visibleMenus.includes('mitglieder');
  if (!isOwner && !isStaff) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  let registration;
  try {
    registration = await updateRegistrationOtFields(params.id, params.userId, body);
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    throw err;
  }
  await notifyRegistrationOtFieldsChanged(params.id, params.userId);
  return { status: 200, body: registration };
}));
```

- [ ] **Step 6: Merge registration-scoped OT fields into `listParticipantsForEvent`**

```javascript
import { ENCRYPTED_REGISTRATION_FIELD_COLUMNS } from '../registrationFields.js';
```

```javascript
export async function listParticipantsForEvent(eventId, { schema = [], viewer } = {}) {
  const otKeys = (viewer?.group?.accountFields ?? []).filter((key) => key in ENCRYPTED_ACCOUNT_FIELD_COLUMNS);
  const registrationOtKeys = (viewer?.group?.accountFields ?? []).filter((key) => key in ENCRYPTED_REGISTRATION_FIELD_COLUMNS);
  const otColumnsSql = otKeys.map((key) => `, u.${ENCRYPTED_ACCOUNT_FIELD_COLUMNS[key]}`).join('');
  const registrationOtColumnsSql = registrationOtKeys.map((key) => `, r.${ENCRYPTED_REGISTRATION_FIELD_COLUMNS[key]}`).join('');

  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.checked_in_at, r.checked_out_at${otColumnsSql}${registrationOtColumnsSql}
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
  const { rows: characters } = await query(
    `SELECT c.id, c.user_id, c.name, c.data
     FROM characters c
     JOIN registrations r ON r.character_id = c.id
     WHERE r.event_id = $1`,
    [eventId]
  );

  const charactersByUser = new Map();
  for (const c of characters) {
    if (!charactersByUser.has(c.user_id)) charactersByUser.set(c.user_id, []);
    charactersByUser.get(c.user_id).push({
      id: c.id,
      name: c.name,
      data: filterCharacterFields(c, schema, viewer),
    });
  }

  const registered = registrations.map((r) => ({
    userId: r.user_id,
    invitationId: null,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    status: r.status,
    conRole: r.con_role,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    characters: charactersByUser.get(r.user_id) ?? [],
    otFields: {
      ...Object.fromEntries(otKeys.map((key) => [key, decryptField(r[ENCRYPTED_ACCOUNT_FIELD_COLUMNS[key]])])),
      ...Object.fromEntries(registrationOtKeys.map((key) => [key, decryptField(r[ENCRYPTED_REGISTRATION_FIELD_COLUMNS[key]])])),
    },
  }));

  const notified = (await listOpenInvitationsForEvent(eventId)).map((inv) => ({
    userId: null,
    invitationId: inv.invitationId,
    name: inv.name,
    status: 'notified',
    checkedInAt: null,
    checkedOutAt: null,
    characters: [],
    otFields: {},
  }));

  return [...notified, ...registered];
}
```

(`getScanLookup` is unchanged — it never returned OT fields of either kind.)

- [ ] **Step 7: Add tests to `tests/integration/registrations.test.js`**

```javascript
test('registering with otFields stores them, returned decrypted via GET /registrations', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', otFields: { conTage: '3', accommodation: 'OT-Zelt', dataSharingOptOut: 'Ja' } }),
    });
    assert.equal(res.status, 201);

    const list = await (await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: cookie } })).json();
    const registration = list.find((r) => r.eventId === eventId);
    assert.equal(registration.conTage, '3');
    assert.equal(registration.accommodation, 'OT-Zelt');
    assert.equal(registration.dataSharingOptOut, 'Ja');
    assert.equal(registration.craftOffer, null);
  });
});

test('PUT .../ot-fields updates fields for the registration owner and does not touch con_role/character', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', otFields: { conTage: '1' } }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conTage: '5', travelMethod: 'Bahn' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.conTage, '5');
    assert.equal(body.travelMethod, 'Bahn');
    assert.equal(body.conRole, 'helfer');
  });
});

test('PUT .../ot-fields is forbidden for a non-owner without mitglieder menu access', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${owner.userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ conTage: '9' }),
    });
    assert.equal(res.status, 403);
  });
});

test('PUT .../ot-fields allows staff with mitglieder menu access to edit another user\'s registration', async () => {
  await withTestServer(async (port) => {
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');
    const owner = await makeUserAndSession();
    const eventId = await makeEvent();
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mod', 'Staff', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`mod-otfields-${crypto.randomUUID()}@example.com`]
    );
    const modCookie = `session=${(await createSession(rows[0].id)).token}`;

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${owner.userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: modCookie },
      body: JSON.stringify({ accommodation: 'Hütte' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).accommodation, 'Hütte');
  });
});

test('PUT .../ot-fields on an unknown registration returns 404', async () => {
  await withTestServer(async (port) => {
    const { cookie, userId } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conTage: '1' }),
    });
    assert.equal(res.status, 404);
  });
});

test('resolveOtFieldsChangeRecipients returns event orga/hilfs_orga plus system admin/moderator, not a plain bystander', async () => {
  await withTestServer(async (port) => {
    const { resolveOtFieldsChangeRecipients } = await import('../../backend/registrations/repository.js');
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');
    const eventId = await makeEvent();

    async function makeUserWithGroup(groupKey, email) {
      const { rows } = await query(
        "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'R', 'T', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
        [email, groupKey]
      );
      const session = await createSession(rows[0].id);
      return { userId: rows[0].id, cookie: `session=${session.token}`, email };
    }

    const orga = await makeUserWithGroup('mitglied', `orga-recip-${crypto.randomUUID()}@example.com`);
    const admin = await makeUserWithGroup('admin', `admin-recip-${crypto.randomUUID()}@example.com`);
    const bystander = await makeUserWithGroup('mitglied', `bystander-recip-${crypto.randomUUID()}@example.com`);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: orga.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    await query("UPDATE registrations SET con_role = 'orga' WHERE event_id = $1 AND user_id = $2", [eventId, orga.userId]);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const recipients = await resolveOtFieldsChangeRecipients(eventId);
    assert.ok(recipients.includes(orga.email));
    assert.ok(recipients.includes(admin.email));
    assert.equal(recipients.includes(bystander.email), false);
  });
});
```

- [ ] **Step 8: Add a test to `tests/integration/checkin.test.js`**

Add near the existing `'participants list filters character (IT) fields by canOverrideCheckinStatus and the schema\'s public flag'` test:

```javascript
test('participants list exposes registration-scoped OT fields (conTage etc.) the same way as account-scoped ones', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: attendee.cookie },
      body: JSON.stringify({ conRole: 'helfer', otFields: { conTage: '4', accommodation: 'IT-Zelt' } }),
    });

    const adminList = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: admin.cookie } });
    const entry = (await adminList.json()).find((p) => p.userId === attendee.userId);
    assert.equal(entry.otFields.conTage, '4');
    assert.equal(entry.otFields.accommodation, 'IT-Zelt');
  });
});
```

- [ ] **Step 9: Run the scoped tests**

Run: `node --test tests/integration/registrations.test.js tests/integration/checkin.test.js tests/integration/scanLookup.test.js`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/registrations/repository.js backend/registrations/routes.js backend/auth/mailer.js tests/integration/registrations.test.js tests/integration/checkin.test.js
git commit -m "feat: registration-scoped OT fields (otFields on register, PUT .../ot-fields with owner-or-staff auth and change notification)"
```

---

### Task 3: Frontend — Formular-Felder, Bearbeiten-UI, vollständiger Testlauf

**Files:**
- Modify: `frontend/js/formFields.js`
- Modify: `frontend/con-anmeldungen.html`
- Modify: `frontend/account.html`
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `PUT /events/:id/registrations/:userId/ot-fields`, `POST /events/:id/register` with `{ conRole, characterId, otFields }`, `GET /registrations` (now includes the 6 decrypted fields) — all from Task 2.

- [ ] **Step 1: Split `ACCOUNT_FIELD_LABELS` in `frontend/js/formFields.js`**

```javascript
// OT (out-of-time) member fields: the encrypted, personal data columns a
// group's account_fields permission can grant access to.
export const ACCOUNT_FIELD_LABELS = {
  address: 'Adresse', birthdate: 'Geburtsdatum', phone: 'Telefon',
  emergencyContactLastName: 'Notfallkontakt: Name', emergencyContactFirstName: 'Notfallkontakt: Vorname', emergencyContactPhone: 'Notfallkontakt: Telefonnummer',
  medicalNotes: 'Gesundheitshinweise',
};

// OT fields scoped to a single Con-Anmeldung instead of the account (moved
// there in Teil 3 of the user-testing feedback package) -- the same
// group.accountFields permission list gates visibility of these too.
export const REGISTRATION_FIELD_LABELS = {
  conTage: 'Con-Tage des Spielers',
  accommodation: 'Unterbringung (Hütte/IT-Zelt/OT-Zelt, Anzahl, qm)',
  craftOffer: 'Angebotenes Handwerk',
  travelMethod: 'Anreise (Auto/Motorrad, Bahn, muss abgeholt werden)',
  dataSharingOptOut: 'Daten nicht an andere Teilnehmer weitergeben (Ja/Nein)',
  photoOptOut: 'Keine Fotoveröffentlichung (Ja/Nein)',
};
```

(Everything else in the file — `STATUS_LABELS`, `isOptOutYes`, `OPT_OUT_KEYS`, `renderAccountFieldInput`, `renderField`, `collectFieldValues`, etc. — is unchanged; `OPT_OUT_KEYS` still lists the same two keys, now belonging to the new constant.)

- [ ] **Step 2: `frontend/account.html`— remove the 6 fields**

Remove these 10 lines from the form markup (between the `medicalNotes` textarea and the submit button):

```html
      <label for="conTage">Con-Tage des Spielers <span class="sealed">Verschlüsselt</span></label>
      <input id="conTage" name="conTage" type="text">
      <label for="accommodation">Unterbringung (Hütte/IT-Zelt/OT-Zelt, Anzahl, qm) <span class="sealed">Verschlüsselt</span></label>
      <input id="accommodation" name="accommodation" type="text">
      <label for="craftOffer">Angebotenes Handwerk <span class="sealed">Verschlüsselt</span></label>
      <input id="craftOffer" name="craftOffer" type="text">
      <label for="travelMethod">Anreise (Auto/Motorrad, Bahn, muss abgeholt werden) <span class="sealed">Verschlüsselt</span></label>
      <input id="travelMethod" name="travelMethod" type="text">
      <label for="dataSharingOptOut"><input id="dataSharingOptOut" name="dataSharingOptOut" type="checkbox"> Daten nicht an andere Teilnehmer weitergeben <span class="sealed">Verschlüsselt</span></label>
      <label for="photoOptOut"><input id="photoOptOut" name="photoOptOut" type="checkbox"> Keine Fotoveröffentlichung <span class="sealed">Verschlüsselt</span></label>
```

In the script, `loadAccount()`'s field list loses the 4 text keys, and the two opt-out lines are removed:

```javascript
async function loadAccount() {
  try {
    const account = await api.get('/account');
    document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
    for (const field of ['firstName', 'lastName', 'nickname', 'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes']) {
      form.elements[field].value = account[field] ?? '';
    }
    formControls.forEach((el) => { el.disabled = false; });
    await loadQrCode(account);
  } catch (err) {
    if (err.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    message.textContent = err.message;
    message.className = 'error';
  }
}
```

The submit handler loses the two opt-out override lines:

```javascript
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    await api.patch('/account', data);
    message.textContent = 'Gespeichert.';
    message.className = 'success';
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});
```

The `isOptOutYes` import becomes unused — remove it from the import line (keep `attachBirthdateFormatter`, `attachLiveValidation`):

```javascript
import { attachBirthdateFormatter, attachLiveValidation } from '/js/formFields.js';
```

- [ ] **Step 3: `frontend/con-anmeldungen.html` — add the 6 fields to "Neu anmelden"**

Add a container after the existing `#dynamic-fields` div, before the submit button:

```html
      <div id="dynamic-fields"></div>

      <h3>Weitere Angaben zu dieser Anmeldung</h3>
      <div id="ot-fields"></div>

      <button type="submit" id="register-button">Anmelden</button>
```

In the script, import `REGISTRATION_FIELD_LABELS` and `renderAccountFieldInput`, render the fields once on load, and collect them on submit:

```javascript
import { escapeHtml, renderField, collectFieldValues, attachLiveValidation, STATUS_LABELS, renderEventOptions, renderAccountFieldInput, REGISTRATION_FIELD_LABELS } from '/js/formFields.js';
```

```javascript
const otFieldsContainer = document.getElementById('ot-fields');

function renderOtFields(values = {}) {
  otFieldsContainer.innerHTML = Object.entries(REGISTRATION_FIELD_LABELS)
    .map(([key, label]) => renderAccountFieldInput(key, label, values[key]))
    .join('');
  attachLiveValidation(otFieldsContainer);
}

function collectOtFields() {
  const result = {};
  otFieldsContainer.querySelectorAll('[data-field]').forEach((input) => {
    result[input.dataset.field] = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
  });
  return result;
}
```

Add `let currentUserId = null;` alongside the existing top-level `let events = []; let characters = []; let canEditCharacters = false; let isModeratorOrAdmin = false;` block — the edit-save handler (Step 4) reads it instead of doing its own `/account` round-trip. Call `renderOtFields();` once during the initial `try` block, alongside the existing `loadEvents()`/`loadCharacters()`/`loadRegistrations()` calls:

```javascript
try {
  const account = await api.get('/account');
  currentUserId = account.id;
  canEditCharacters = account.canEditCharacters;
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  isModeratorOrAdmin = account.group?.key === 'admin' || account.group?.key === 'moderator';
  if (!isModeratorOrAdmin) {
    document.querySelectorAll('#con-role-select option[data-staff-only]').forEach((opt) => opt.remove());
  }
  renderOtFields();
  await loadEvents();
  await loadCharacters();
  await loadRegistrations();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
}
```

Include the collected fields in the register submit handler:

```javascript
registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const eventId = eventSelect.value;
  const conRole = conRoleSelect.value;
  const needsCharacter = ['sc', 'gsc', 'nsc'].includes(conRole);
  const characterId = needsCharacter ? characterSelect.value : undefined;
  if (needsCharacter && !characterId) return;

  try {
    if (['sc', 'gsc'].includes(conRole)) {
      const schema = events.find((e) => e.id === eventId)?.character_form_schema ?? [];
      const data = collectFieldValues(registrationForm, schema);
      await api.put(`/characters/${characterId}`, { eventId, data });
    }
    await api.post(`/events/${eventId}/register`, { conRole, characterId, otFields: collectOtFields() });
    message.textContent = 'Angemeldet.';
    message.className = 'success';
    renderOtFields();
    await loadRegistrations();
  } catch (err) {
    message.textContent = err.status === 400 && err.body?.details
      ? err.body.details.join(', ')
      : err.message;
    message.className = 'error';
  }
});
```

- [ ] **Step 4: `frontend/con-anmeldungen.html` — add the "Bearbeiten" flow to "Meine Anmeldungen"**

Add an edit dialog to the page markup, right after the `#registration-list` table:

```html
    <table id="registration-list">
      <thead><tr><th>Event</th><th>Rolle</th><th>Status</th><th></th></tr></thead>
      <tbody></tbody>
    </table>

    <dialog id="edit-ot-dialog">
      <h3>Anmeldungsdaten bearbeiten</h3>
      <p class="lede">Diese Änderung benachrichtigt die Orga und Admin dieses Events per E-Mail.</p>
      <div id="edit-ot-fields"></div>
      <div class="dialog-actions">
        <button type="button" id="edit-ot-save">Speichern</button>
        <button type="button" id="edit-ot-cancel" class="btn-ghost">Abbrechen</button>
      </div>
    </dialog>
```

Change the "Abmelden" cell to also show "Bearbeiten" for every registration, regardless of status, and wire the dialog:

```javascript
async function loadRegistrations() {
  const registrations = await api.get('/registrations');
  currentRegistrations = registrations;
  registrationListBody.innerHTML = registrations.map((r) => {
    const label = STATUS_LABELS[r.status] ?? r.status;
    return `<tr>
    <td>${escapeHtml(r.eventName)}</td>
    <td>${escapeHtml(CON_ROLE_LABELS[r.conRole] ?? r.conRole)}</td>
    <td><span class="ribbon status-${escapeHtml(r.status)}">${escapeHtml(label)}</span></td>
    <td>
      <button type="button" data-edit-ot="${r.eventId}">Bearbeiten</button>
      ${r.status === 'pending' ? `<button type="button" data-unregister="${r.eventId}">Abmelden</button>` : ''}
    </td>
  </tr>`;
  }).join('');

  registrationListBody.querySelectorAll('[data-unregister]').forEach((button) => {
    button.addEventListener('click', () => unregister(button.dataset.unregister));
  });
  registrationListBody.querySelectorAll('[data-edit-ot]').forEach((button) => {
    button.addEventListener('click', () => openEditOtDialog(button.dataset.editOt));
  });
}
```

Add `currentRegistrations`, the dialog open/save/cancel wiring, near `renderOtFields`/`collectOtFields`:

```javascript
let currentRegistrations = [];
const editOtDialog = document.getElementById('edit-ot-dialog');
const editOtFieldsContainer = document.getElementById('edit-ot-fields');
let editingEventId = null;

function openEditOtDialog(eventId) {
  const registration = currentRegistrations.find((r) => r.eventId === eventId);
  if (!registration) return;
  editingEventId = eventId;
  editOtFieldsContainer.innerHTML = Object.entries(REGISTRATION_FIELD_LABELS)
    .map(([key, label]) => renderAccountFieldInput(key, label, registration[key]))
    .join('');
  attachLiveValidation(editOtFieldsContainer);
  editOtDialog.showModal();
}

document.getElementById('edit-ot-cancel').addEventListener('click', () => {
  editingEventId = null;
  editOtDialog.close();
});

document.getElementById('edit-ot-save').addEventListener('click', async () => {
  const payload = {};
  editOtFieldsContainer.querySelectorAll('[data-field]').forEach((input) => {
    payload[input.dataset.field] = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
  });
  message.textContent = '';
  message.className = '';
  try {
    await api.put(`/events/${editingEventId}/registrations/${currentUserId}/ot-fields`, payload);
    editOtDialog.close();
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    await loadRegistrations();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});
```

- [ ] **Step 5: `frontend/admin/checkin.html` — combined label map for the column selector**

Import `REGISTRATION_FIELD_LABELS` and build a combined map used everywhere `ACCOUNT_FIELD_LABELS` currently drives the OT column list:

```javascript
import { escapeHtml, formatFieldValue, ACCOUNT_FIELD_LABELS, REGISTRATION_FIELD_LABELS, STATUS_LABELS, renderEventOptions, renderAccountFieldInput, renderField, collectFieldValues } from '/js/formFields.js';
```

```javascript
const OT_FIELD_LABELS = { ...ACCOUNT_FIELD_LABELS, ...REGISTRATION_FIELD_LABELS };
```

(Add this constant near the other top-level `let`/`const` declarations, e.g. right after `const CON_ROLE_LABELS = ...`.)

Replace the 3 remaining `ACCOUNT_FIELD_LABELS` usages with `OT_FIELD_LABELS`:

```javascript
  const otKeys = Object.keys(OT_FIELD_LABELS).filter((key) => myAccountFields.includes(key));
  otColumnCheckboxes.innerHTML = otKeys.map((key) => `
    <label><input type="checkbox" data-ot-column="${escapeHtml(key)}" ${selectedColumns.ot.includes(key) ? 'checked' : ''}> ${escapeHtml(OT_FIELD_LABELS[key])}</label>
  `).join('');
```

```javascript
  const otLabels = selectedColumns.ot.map((key) => OT_FIELD_LABELS[key] ?? key);
```

```javascript
  const otKeys = canManageMembers ? Object.keys(p.otFields ?? {}) : [];
  editOtFields.innerHTML = otKeys.length > 0
    ? `<h3>Konto-Felder</h3>` + otKeys.map((key) => renderAccountFieldInput(key, OT_FIELD_LABELS[key] ?? key, p.otFields[key])).join('')
    : '';
```

- [ ] **Step 6: `frontend/admin/checkin.html` — split the edit-dialog save payload**

Replace the `edit-save` click handler so account-scoped keys go to `PATCH /members/:id` and registration-scoped keys go to the new route:

```javascript
document.getElementById('edit-save').addEventListener('click', async () => {
  message.textContent = '';
  message.className = '';
  const accountPayload = {};
  const registrationPayload = {};
  editOtFields.querySelectorAll('[data-field]').forEach((input) => {
    const value = input.type === 'checkbox' ? (input.checked ? 'Ja' : 'Nein') : input.value;
    if (input.dataset.field in ACCOUNT_FIELD_LABELS) accountPayload[input.dataset.field] = value;
    else registrationPayload[input.dataset.field] = value;
  });
  const characterForms = [...editCharacters.querySelectorAll('.checkin-character-form')];
  let savedAnything = false;
  try {
    if (Object.keys(accountPayload).length > 0) {
      await api.patch(`/members/${editingUserId}`, accountPayload);
      savedAnything = true;
    }
    if (Object.keys(registrationPayload).length > 0) {
      await api.put(`/events/${eventSelect.value}/registrations/${editingUserId}/ot-fields`, registrationPayload);
      savedAnything = true;
    }
    for (const form of characterForms) {
      const data = collectFieldValues(form, currentSchema);
      await api.put(`/characters/${form.dataset.characterId}`, { data });
      savedAnything = true;
    }
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    editDialog.close();
    await loadParticipants(eventSelect.value);
  } catch (err) {
    message.textContent = savedAnything
      ? `Teilweise gespeichert, dann Fehler: ${err.message}`
      : err.message;
    message.className = 'error';
    if (savedAnything) {
      editDialog.close();
      await loadParticipants(eventSelect.value);
    }
  }
});
```

- [ ] **Step 7: Verify visually**

Using Claude Browser tools against the running dev stack:
1. Log in as a plain `mitglied`-tier user, go to `/account.html` — confirm the 6 fields (Con-Tage, Unterbringung, Handwerk, Anreise, both Opt-Outs) are gone, remaining fields still work.
2. Go to `/con-anmeldungen.html`, select an active event, role "Helfer" — confirm the "Weitere Angaben zu dieser Anmeldung" section renders all 6 fields, fill them in, submit — confirm "Angemeldet." and the row appears in "Meine Anmeldungen".
3. Click "Bearbeiten" on that row — confirm the dialog opens pre-filled with the values just submitted, change one field, save — confirm "Gespeichert." and the change persists (reopen the dialog, value updated).
4. Log in as `admin`, go to `/admin/checkin.html` for that event — open the column selector, confirm the 6 fields are selectable as OT columns, select one, confirm the value shows in the table for that participant.
5. Open the participant's "Bearbeiten" dialog on the checkin page — confirm both account fields (e.g. Adresse) and the 6 registration fields render together under "Konto-Felder", change one of each kind, save — confirm both persist (reload participants, values updated).

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/js/formFields.js frontend/con-anmeldungen.html frontend/account.html frontend/admin/checkin.html
git commit -m "feat: Anmeldeformular UI for the 6 OT fields (register + Bearbeiten dialog), remove them from account.html, checkin.html column selector and edit dialog updated"
```
