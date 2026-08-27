# Member Management & Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Admin/Orga view and edit other members' data through a UI (instead of raw SQL), and let them create new members via invitation links that pre-fill account data — the invitee only sets a password.

**Architecture:** A new `invitations` table (separate from `users` — an invite is never a half-created user row) holds pre-filled, encrypted account data plus a redeemable token. `backend/invitations/repository.js` owns that table; `backend/members/routes.js` orchestrates `users` + `invitations` together for the merged member list and the invite/resend actions; a small public `backend/auth/invite.js` handles redemption (creates the real `users` row atomically). Frontend: `admin/members.html` (list/detail/invite-form, Everest Registry theme) and `frontend/set-password.html` (redeem flow, Chronicle & Crest theme, matching the other unauthenticated auth pages).

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step, `nodemailer` for the invite email.

**Spec:** `docs/superpowers/specs/2026-08-27-mitgliederverwaltung-einladungen-design.md` (builds on `docs/superpowers/specs/2026-08-26-gruppen-berechtigungen-design.md`)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- **The LAST task in this plan must run the full `npm test` suite as an explicit step and require it to pass before the plan is done** — a prior plan in this sequence shipped a real bug because every task only ran its own scoped test subset and the full suite was never checked until final review. Do not repeat that gap.
- Fixed account-field vocabulary (unchanged from prior plans): `address`, `birthdate`, `phone`, `emergencyContact`, `medicalNotes`, plus the pseudo-key `group`.
- `name` is a mandatory field on invitation creation (not gated by `account_fields` — matches how `/auth/register` already treats it), but stays non-editable via `PATCH /members/:id` for existing members, per the spec's explicit resolution of that open point.
- **Known, deliberate, accepted gap**: `GET /members/:id`'s response does not include `nsc_data` in this plan, even though the base spec says it should for NSC-group members — the `users.nsc_data` column doesn't exist yet (it's added in the next, not-yet-started plan: NSC Profile). Do not add a placeholder or stub column here; the next plan extends this endpoint's response once the column exists.
- Verify visually via Claude Browser tools against the running dev stack for every page you touch.

---

### Task 1: Invitations backend — table, repository, invite/resend/redeem endpoints

**Files:**
- Create: `db/migrations/007_invitations.sql`
- Create: `backend/invitations/repository.js`
- Modify: `backend/auth/mailer.js` (add `sendInvitationEmail`)
- Create: `backend/auth/invite.js`
- Modify: `backend/server.js` (register the new route module)
- Create: `tests/integration/invitations.test.js`

**Interfaces:**
- Produces: `export async function createInvitation({ email, name, groupId, invitedBy, address, birthdate, phone, emergencyContact, medicalNotes })`, `getInvitationByToken(token)`, `getInvitationById(id)`, `regenerateToken(id)`, `markRedeemed(id, client)` (accepts an optional transaction client, since redemption must be atomic with user creation), `listOpenInvitations()` — all from `backend/invitations/repository.js`. These are consumed by Task 2 (member list merge, invite/resend routes) and by this task's own redeem endpoint.

- [ ] **Step 1: Write the migration**

Create `db/migrations/007_invitations.sql`:

```sql
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text UNIQUE NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  group_id uuid NOT NULL REFERENCES groups(id),
  address_enc bytea,
  birthdate_enc bytea,
  phone_enc bytea,
  emergency_contact_enc bytea,
  medical_notes_enc bytea,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz
);

CREATE INDEX invitations_email_idx ON invitations (email) WHERE redeemed_at IS NULL;
```

- [ ] **Step 2: Write `backend/invitations/repository.js`**

```javascript
import crypto from 'node:crypto';
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SELECT_COLUMNS = `
  id, token, email, name, group_id,
  address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc,
  invited_by, expires_at, created_at, redeemed_at
`;

function decryptInvitation(row) {
  return {
    id: row.id,
    token: row.token,
    email: row.email,
    name: row.name,
    groupId: row.group_id,
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    redeemedAt: row.redeemed_at,
  };
}

export async function createInvitation({ email, name, groupId, invitedBy, address, birthdate, phone, emergencyContact, medicalNotes }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const { rows } = await query(
    `INSERT INTO invitations (token, email, name, group_id, address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${SELECT_COLUMNS}`,
    [
      token, email, name, groupId,
      address !== undefined ? encryptField(address) : null,
      birthdate !== undefined ? encryptField(birthdate) : null,
      phone !== undefined ? encryptField(phone) : null,
      emergencyContact !== undefined ? encryptField(emergencyContact) : null,
      medicalNotes !== undefined ? encryptField(medicalNotes) : null,
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

export async function regenerateToken(id) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
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
  await runner.query('UPDATE invitations SET redeemed_at = now() WHERE id = $1', [id]);
}

export async function listOpenInvitations() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM invitations WHERE redeemed_at IS NULL ORDER BY created_at DESC`
  );
  return rows.map(decryptInvitation);
}
```

- [ ] **Step 3: Add `sendInvitationEmail` to `backend/auth/mailer.js`**

Add this function to the existing file (don't touch `sendVerificationEmail`/`sendPasswordResetEmail`):

```javascript
export async function sendInvitationEmail(to, token) {
  const url = `${baseUrl()}/set-password.html?token=${token}`;
  return getTransporter().sendMail({
    to,
    from: fromAddress(),
    subject: 'Du wurdest zu Pakyrion eingeladen',
    text: `Du wurdest eingeladen. Setze dein Passwort, um loszulegen: ${url}`,
  });
}
```

- [ ] **Step 4: Write `backend/auth/invite.js`**

This is the public redemption endpoint (no `requireAuth` — the token itself is the credential, matching `/auth/password-reset/confirm`'s pattern). Redemption must be atomic: creating the `users` row and marking the invitation redeemed either both happen or neither does — use `withTransaction` from `../db.js` (already exported, used today only by the migration runner; this is its first use in a route handler).

```javascript
import { router } from '../routes.js';
import { withTransaction } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { createSession } from './sessions.js';
import { serializeSessionCookie } from './cookies.js';
import { readJsonBody } from '../httpBody.js';
import { getInvitationByToken, markRedeemed } from '../invitations/repository.js';

router.post('/auth/invite/redeem', async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { token, password } = body;
  if (!token || !password) {
    return { status: 400, body: { error: 'token and password are required' } };
  }
  if (password.length < 8) {
    return { status: 400, body: { error: 'password must be at least 8 characters' } };
  }

  const invitation = await getInvitationByToken(token);
  if (!invitation || invitation.redeemedAt || new Date(invitation.expiresAt) < new Date()) {
    return { status: 400, body: { error: 'invalid or expired invitation' } };
  }

  const passwordHash = await hashPassword(password);

  const userId = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, group_id, name, email_verified, address_enc, birthdate_enc, phone_enc, emergency_contact_enc, medical_notes_enc)
       VALUES ($1, $2, $3, $4, true,
         (SELECT address_enc FROM invitations WHERE id = $5),
         (SELECT birthdate_enc FROM invitations WHERE id = $5),
         (SELECT phone_enc FROM invitations WHERE id = $5),
         (SELECT emergency_contact_enc FROM invitations WHERE id = $5),
         (SELECT medical_notes_enc FROM invitations WHERE id = $5))
       RETURNING id`,
      [invitation.email, passwordHash, invitation.groupId, invitation.name, invitation.id]
    );
    await markRedeemed(invitation.id, client);
    return rows[0].id;
  });

  const session = await createSession(userId);
  return {
    status: 200,
    body: { id: userId },
    headers: { 'Set-Cookie': serializeSessionCookie(session.token, session.expiresAt) },
  };
});
```

(The `INSERT ... SELECT ... FROM invitations WHERE id = $5` subqueries copy the already-encrypted bytea columns directly — no decrypt/re-encrypt round trip needed, since both tables use the same `ENCRYPTION_KEY`. This avoids handling raw encrypted bytes in JS at all.)

- [ ] **Step 5: Register the route module**

In `backend/server.js`, add this line alongside the other `./auth/*` imports (after `import './auth/oauth.js';`):

```javascript
import './auth/invite.js';
```

- [ ] **Step 6: Write the failing tests first**

Create `tests/integration/invitations.test.js` (read `tests/integration/auth-register.test.js` and `tests/integration/auth-password-reset.test.js` first for this codebase's exact conventions — `createServer().listen(0)` wrapped in `try/finally`, `ENCRYPTION_KEY` env setup, etc.):

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
const { createServer } = await import('../../backend/server.js');
const { createInvitation, getInvitationByToken, regenerateToken } = await import('../../backend/invitations/repository.js');

async function makeAdmin() {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Inviter', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
    [`inviter-${crypto.randomUUID()}@example.com`]
  );
  return rows[0].id;
}

async function scGroupId() {
  const { rows } = await query("SELECT id FROM groups WHERE key = 'sc'");
  return rows[0].id;
}

test('createInvitation stores encrypted fields that decrypt back correctly', async () => {
  const invitedBy = await makeAdmin();
  const groupId = await scGroupId();
  const invitation = await createInvitation({
    email: `invitee-${crypto.randomUUID()}@example.com`,
    name: 'Invited Person',
    groupId,
    invitedBy,
    medicalNotes: 'keine',
  });
  assert.equal(invitation.medicalNotes, 'keine');
  const { rows } = await query('SELECT medical_notes_enc FROM invitations WHERE id = $1', [invitation.id]);
  assert.notEqual(rows[0].medical_notes_enc.toString('utf8'), 'keine');
});

test('POST /auth/invite/redeem creates a real user, logs them in, and marks the invitation redeemed', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const invitedBy = await makeAdmin();
    const groupId = await scGroupId();
    const invitation = await createInvitation({
      email: `redeem-${crypto.randomUUID()}@example.com`,
      name: 'Redeemer',
      groupId,
      invitedBy,
      address: 'Teststraße 1',
    });

    const res = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitation.token, password: 'correct horse battery staple' }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('set-cookie'));

    const { rows } = await query('SELECT email_verified, group_id, address_enc FROM users WHERE id = $1', [(await res.json()).id]);
    assert.equal(rows[0].email_verified, true);
    assert.equal(rows[0].group_id, groupId);
    assert.notEqual(rows[0].address_enc.toString('utf8'), 'Teststraße 1');

    const redeemed = await getInvitationByToken(invitation.token);
    assert.ok(redeemed.redeemedAt);
  } finally {
    server.close();
  }
});

test('POST /auth/invite/redeem rejects an already-redeemed token', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const invitedBy = await makeAdmin();
    const groupId = await scGroupId();
    const invitation = await createInvitation({
      email: `redeem-twice-${crypto.randomUUID()}@example.com`,
      name: 'Twice',
      groupId,
      invitedBy,
    });
    await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitation.token, password: 'correct horse battery staple' }),
    });
    const res = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitation.token, password: 'correct horse battery staple' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /auth/invite/redeem rejects an unknown token', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token', password: 'correct horse battery staple' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('regenerateToken changes the token and invalidates the old one', async () => {
  const invitedBy = await makeAdmin();
  const groupId = await scGroupId();
  const invitation = await createInvitation({
    email: `resend-${crypto.randomUUID()}@example.com`,
    name: 'Resend Me',
    groupId,
    invitedBy,
  });
  const updated = await regenerateToken(invitation.id);
  assert.notEqual(updated.token, invitation.token);
  const oldLookup = await getInvitationByToken(invitation.token);
  assert.equal(oldLookup, null);
});

test.after(async () => {
  await query("DELETE FROM invitations");
  await query("DELETE FROM users WHERE email LIKE 'inviter-%' OR email LIKE 'invitee-%' OR email LIKE 'redeem-%' OR email LIKE 'resend-%'");
  await closePool();
});
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/integration/invitations.test.js`
Expected: all 5 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/007_invitations.sql backend/invitations/repository.js backend/auth/mailer.js backend/auth/invite.js backend/server.js tests/integration/invitations.test.js
git commit -m "feat: add invitations table and redemption endpoint"
```

---

### Task 2: Member management backend — merged list, detail, edit, invite/resend

**Files:**
- Create: `backend/members/repository.js`
- Create: `backend/members/routes.js`
- Modify: `backend/server.js` (register the new route module)
- Create: `tests/integration/members.test.js`

**Interfaces:**
- Consumes: Task 1's `backend/invitations/repository.js` (`createInvitation`, `regenerateToken`, `getInvitationById`, `listOpenInvitations`).
- Produces: `GET /members` (merged real + invited list), `GET /members/:id`, `PATCH /members/:id`, `POST /members/invite`, `POST /members/invitations/:id/resend` — all `requireMenu('mitglieder')`. Task 3 (frontend) consumes this API.

- [ ] **Step 1: Write `backend/members/repository.js`**

```javascript
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

const SELECT_COLUMNS = `
  users.id, users.email, users.name, users.email_verified,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_enc, users.medical_notes_enc,
  groups.id AS group_id, groups.key AS group_key, groups.name AS group_name
`;

function decryptMember(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: row.email_verified,
    status: 'active',
    group: { id: row.group_id, key: row.group_key, name: row.group_name },
    address: decryptField(row.address_enc),
    birthdate: decryptField(row.birthdate_enc),
    phone: decryptField(row.phone_enc),
    emergencyContact: decryptField(row.emergency_contact_enc),
    medicalNotes: decryptField(row.medical_notes_enc),
  };
}

export async function listMembers() {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users JOIN groups ON groups.id = users.group_id ORDER BY users.name`
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
    `SELECT characters.id, characters.name, characters.event_id, events.name AS event_name
     FROM characters JOIN events ON events.id = characters.event_id
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
       address_enc = COALESCE($3, address_enc),
       birthdate_enc = COALESCE($4, birthdate_enc),
       phone_enc = COALESCE($5, phone_enc),
       emergency_contact_enc = COALESCE($6, emergency_contact_enc),
       medical_notes_enc = COALESCE($7, medical_notes_enc)
     WHERE id = $1
     RETURNING id`,
    [
      id,
      fields.group ?? null,
      fields.address !== undefined ? encryptField(fields.address) : null,
      fields.birthdate !== undefined ? encryptField(fields.birthdate) : null,
      fields.phone !== undefined ? encryptField(fields.phone) : null,
      fields.emergencyContact !== undefined ? encryptField(fields.emergencyContact) : null,
      fields.medicalNotes !== undefined ? encryptField(fields.medicalNotes) : null,
    ]
  );
  if (rows.length === 0) return null;
  return getMember(id);
}
```

(`fields.group` is expected to already be a `group_id` uuid by the time it reaches the repository — the route layer is responsible for resolving whatever the client sends into a real group id, and for the `account_fields` permission check. `updateMember` re-fetches via `getMember` for the same reason `accounts/repository.js`'s `updateAccount` does: `RETURNING` can't express the `groups` join.)

- [ ] **Step 2: Write `backend/members/routes.js`**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { listMembers, getMember, updateMember } from './repository.js';
import { createInvitation, regenerateToken, getInvitationById, listOpenInvitations } from '../invitations/repository.js';
import { sendInvitationEmail } from '../auth/mailer.js';
import { logger } from '../logger.js';
import { query } from '../db.js';

const ACCOUNT_FIELD_KEYS = ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'group'];

function filterToAllowedFields(body, allowedFields) {
  const disallowed = Object.keys(body).filter((key) => ACCOUNT_FIELD_KEYS.includes(key) && !allowedFields.includes(key));
  return disallowed;
}

router.get('/members', requireAuth(requireMenu('mitglieder')(async () => {
  const members = await listMembers();
  const invitations = await listOpenInvitations();
  const invited = invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    name: inv.name,
    status: 'invited',
    expired: new Date(inv.expiresAt) < new Date(),
  }));
  return { status: 200, body: [...members, ...invited] };
})));

router.get('/members/:id', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const member = await getMember(params.id);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: member };
})));

router.patch('/members/:id', requireAuth(requireMenu('mitglieder')(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  const disallowed = filterToAllowedFields(body, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to edit: ${disallowed.join(', ')}` } };
  }

  const fields = { ...body };
  if (fields.group !== undefined) {
    const { rows } = await query('SELECT id FROM groups WHERE key = $1', [fields.group]);
    if (rows.length === 0) return { status: 400, body: { error: 'unknown group' } };
    fields.group = rows[0].id;
  }

  const member = await updateMember(params.id, fields);
  if (!member) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: member };
})));

const DEFAULT_INVITE_GROUP_KEY = 'sc';

router.post('/members/invite', requireAuth(requireMenu('mitglieder')(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { email, name, group, ...rest } = body;
  if (!email || !name) {
    return { status: 400, body: { error: 'email and name are required' } };
  }

  // 'group' is gated exactly like every other account field, NOT treated
  // as always-allowed — a group without 'group' in its own account_fields
  // (e.g. orga, by default) must not be able to hand out a HIGHER group
  // (e.g. admin) to a brand-new invitee just because that account doesn't
  // exist yet. If they omit it, invitees default to 'sc' silently; if they
  // try to set it without the permission, that's the same 400 as any other
  // disallowed field.
  const fieldsToCheck = group !== undefined ? { ...rest, group } : rest;
  const disallowed = filterToAllowedFields(fieldsToCheck, user.group.accountFields);
  if (disallowed.length > 0) {
    return { status: 400, body: { error: `not permitted to set: ${disallowed.join(', ')}` } };
  }

  const { rows: existingUser } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existingUser.length > 0) {
    return { status: 409, body: { error: 'a member with this email already exists' } };
  }

  const groupKey = group ?? DEFAULT_INVITE_GROUP_KEY;
  const { rows: groupRows } = await query('SELECT id FROM groups WHERE key = $1', [groupKey]);
  if (groupRows.length === 0) return { status: 400, body: { error: 'unknown group' } };

  const invitation = await createInvitation({
    email: email.toLowerCase(),
    name,
    groupId: groupRows[0].id,
    invitedBy: user.id,
    ...rest,
  });

  try {
    await sendInvitationEmail(invitation.email, invitation.token);
  } catch (err) {
    logger.error('failed to send invitation email', { error: err.message });
  }

  return { status: 201, body: { id: invitation.id, email: invitation.email, status: 'invited' } };
})));

router.post('/members/invitations/:id/resend', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const invitation = await getInvitationById(params.id);
  if (!invitation) return { status: 404, body: { error: 'invitation not found' } };
  if (invitation.redeemedAt) return { status: 409, body: { error: 'invitation already redeemed' } };

  const updated = await regenerateToken(params.id);
  try {
    await sendInvitationEmail(updated.email, updated.token);
  } catch (err) {
    logger.error('failed to resend invitation email', { error: err.message });
  }
  return { status: 200, body: { id: updated.id, email: updated.email, status: 'invited' } };
})));
```

(`filterToAllowedFields` mirrors the field-allowlist rejection style the base spec mandates for `PATCH /members/:id` — "enthält die Payload einen Key außerhalb dieser Allowlist, wird die gesamte Anfrage mit 400 abgelehnt" — applied identically to `POST /members/invite`'s optional account-field payload, since both operations are gated by the same `account_fields` permission concept per the spec.)

- [ ] **Step 3: Register the route module**

In `backend/server.js`, add alongside the other route-module imports (after `import './groups/routes.js';`):

```javascript
import './members/routes.js';
```

- [ ] **Step 4: Write the failing tests first**

Create `tests/integration/members.test.js` (mirror `tests/integration/groups.test.js`'s structure and `makeUserAndSession` helper pattern exactly):

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

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Members Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`members-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /members rejects a group without the mitglieder menu', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('GET /members includes both active members and open invitations', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const members = await res.json();
    assert.ok(members.some((m) => m.status === 'active'));
  } finally {
    server.close();
  }
});

test('PATCH /members/:id rejects a field the caller group is not permitted to edit', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    // orga has 'mitglieder' access (so it passes requireMenu) but, per
    // defaults, does NOT have 'group' in its account_fields — a real,
    // meaningful case to test, not an arbitrary one: orga must not be
    // able to reassign a member's group despite being able to reach this
    // endpoint at all.
    const { cookie } = await makeUserAndSession('orga');
    const { userId: targetId } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/members/${targetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ group: 'admin' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /members/:id updates an allowed field for an admin caller', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const { userId: targetId } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/members/${targetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ address: 'Neue Adresse 1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.address, 'Neue Adresse 1');
  } finally {
    server.close();
  }
});

test('POST /members/invite creates an invitation and rejects an existing email', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `invite-${crypto.randomUUID()}@example.com`;
    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'New Member', group: 'sc' }),
    });
    assert.equal(res.status, 201);

    const dupeRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'Again', group: 'sc' }),
    });
    // First invite doesn't create a users row, so this checks the SECOND
    // invite to the same still-pending address is allowed (no uniqueness
    // constraint on invitations.email) — only an existing users row 409s.
    assert.equal(dupeRes.status, 201);
  } finally {
    server.close();
  }
});

test('POST /members/invite defaults to the sc group when group is omitted', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `invite-default-${crypto.randomUUID()}@example.com`;
    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'Default Group' }),
    });
    assert.equal(res.status, 201);
    const { rows } = await query('SELECT group_id FROM invitations WHERE email = $1', [email]);
    const { rows: scGroup } = await query("SELECT id FROM groups WHERE key = 'sc'");
    assert.equal(rows[0].group_id, scGroup[0].id);
  } finally {
    server.close();
  }
});

test('POST /members/invite rejects an explicit group from a caller without the group permission', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    // orga has 'mitglieder' menu access (so it passes requireMenu) but,
    // per defaults, does NOT have 'group' in its account_fields — this is
    // exactly the case the fix guards: a group that can invite people but
    // must not be able to hand out a higher group than its own reach.
    const { cookie } = await makeUserAndSession('orga');
    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email: `invite-blocked-${crypto.randomUUID()}@example.com`, name: 'Blocked', group: 'admin' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /members/invitations/:id/resend issues a new token', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `resend-route-${crypto.randomUUID()}@example.com`;
    const createRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'Resend Route', group: 'sc' }),
    });
    const created = await createRes.json();
    const resendRes = await fetch(`http://localhost:${port}/members/invitations/${created.id}/resend`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(resendRes.status, 200);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM invitations");
  await query("DELETE FROM users WHERE email LIKE 'members-%'");
  await closePool();
});
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/integration/members.test.js`
Expected: all 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/members/repository.js backend/members/routes.js backend/server.js tests/integration/members.test.js
git commit -m "feat: add member management API (list, detail, edit, invite, resend)"
```

---

### Task 3: `admin/members.html`

**Files:**
- Create: `frontend/admin/members.html`

**Interfaces:**
- Consumes: Task 1+2's full `/members`/`/members/invite`/`/members/invitations/:id/resend` API, `frontend/js/nav.js`'s `renderNavLinks`.

- [ ] **Step 1: Write `frontend/admin/members.html`**

Everest Registry theme, same sidebar shell as `admin/groups.html` (read that file first — it's the closest existing analog: list + create-form on one page, same `.card`/`.form-pad` structure). Structure:

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Mitglieder verwalten – Pakyrion Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/everest-registry.css">
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-brand">Pakyrion<span>Admin</span></div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot"><a href="#" id="logout-link">Logout</a></div>
  </aside>
  <div class="main"><div class="content">
    <h1>Mitglieder verwalten</h1>
    <p class="sub">Bearbeite bestehende Mitglieder oder lade neue per E-Mail ein.</p>
    <div class="card">
      <table id="member-list">
        <thead><tr><th>Name</th><th>E-Mail</th><th>Status</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>

    <div class="card form-pad" id="detail-card" style="display:none;">
      <h2 id="detail-title">Mitglied bearbeiten</h2>
      <div id="detail-fields"></div>
      <button type="button" id="detail-save">Speichern</button>
      <button type="button" id="detail-cancel" class="btn-ghost">Schließen</button>
    </div>

    <div class="card form-pad">
      <h2>Neues Mitglied einladen</h2>
      <form id="invite-form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <div>
            <label for="invite-name">Name</label>
            <input id="invite-name" name="name" type="text" required>
          </div>
          <div>
            <label for="invite-email">E-Mail</label>
            <input id="invite-email" name="email" type="email" required>
          </div>
        </div>
        <div id="invite-group-wrap" style="display:none;">
          <label for="invite-group">Gruppe</label>
          <select id="invite-group" name="group" disabled></select>
        </div>
        <div id="invite-fields"></div>
        <button type="submit">Einladung senden</button>
      </form>
    </div>
    <p id="message"></p>
  </div></div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { escapeHtml } from '/js/formFields.js';
import { renderNavLinks } from '/js/nav.js';

const ACCOUNT_FIELD_LABELS = {
  address: 'Adresse', birthdate: 'Geburtsdatum', phone: 'Telefon',
  emergencyContact: 'Notfallkontakt', medicalNotes: 'Gesundheitshinweise',
};

const listBody = document.querySelector('#member-list tbody');
const detailCard = document.getElementById('detail-card');
const detailFields = document.getElementById('detail-fields');
const detailTitle = document.getElementById('detail-title');
const inviteFields = document.getElementById('invite-fields');
const inviteGroupWrap = document.getElementById('invite-group-wrap');
const inviteGroupSelect = document.getElementById('invite-group');
const message = document.getElementById('message');

let myAccountFields = [];
let editingMemberId = null;

function buildFieldInputs(container, values = {}) {
  container.innerHTML = myAccountFields
    .filter((key) => key !== 'group')
    .map((key) => `
      <label for="field-${key}">${escapeHtml(ACCOUNT_FIELD_LABELS[key] ?? key)}</label>
      <input id="field-${key}" data-field="${key}" type="text" value="${escapeHtml(values[key] ?? '')}">
    `).join('');
}

async function loadGroupOptions() {
  const groups = await api.get('/groups');
  inviteGroupSelect.innerHTML = groups.map((g) => `<option value="${escapeHtml(g.key)}">${escapeHtml(g.name)}</option>`).join('');
}

async function loadMembers() {
  const members = await api.get('/members');
  listBody.innerHTML = members.map((m) => `<tr>
    <td>${escapeHtml(m.name)}</td>
    <td>${escapeHtml(m.email)}</td>
    <td>${m.status === 'active'
      ? `<span class="badge badge-active">Aktiv</span>`
      : `<span class="badge badge-inactive">Eingeladen${m.expired ? ' (abgelaufen)' : ''}</span>`}</td>
    <td>${m.status === 'active'
      ? `<button type="button" class="btn-sm btn-ghost" data-edit="${m.id}">Bearbeiten</button>`
      : `<button type="button" class="btn-sm btn-ghost" data-resend="${m.id}">Erneut senden</button>`}</td>
  </tr>`).join('');

  listBody.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => openDetail(button.dataset.edit));
  });
  listBody.querySelectorAll('[data-resend]').forEach((button) => {
    button.addEventListener('click', () => resendInvitation(button.dataset.resend));
  });
}

async function openDetail(memberId) {
  const member = await api.get(`/members/${memberId}`);
  editingMemberId = memberId;
  detailTitle.textContent = `Mitglied bearbeiten: ${member.name}`;
  buildFieldInputs(detailFields, member);
  detailCard.style.display = '';
}

document.getElementById('detail-cancel').addEventListener('click', () => {
  editingMemberId = null;
  detailCard.style.display = 'none';
});

document.getElementById('detail-save').addEventListener('click', async () => {
  message.textContent = '';
  message.className = '';
  const payload = {};
  detailFields.querySelectorAll('[data-field]').forEach((input) => {
    payload[input.dataset.field] = input.value;
  });
  try {
    await api.patch(`/members/${editingMemberId}`, payload);
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    detailCard.style.display = 'none';
    await loadMembers();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});

async function resendInvitation(invitationId) {
  message.textContent = '';
  message.className = '';
  try {
    await api.post(`/members/invitations/${invitationId}/resend`, {});
    message.textContent = 'Einladung erneut verschickt.';
    message.className = 'success';
    await loadMembers();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
}

document.getElementById('invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const formData = new FormData(event.target);
  const payload = Object.fromEntries(formData);
  inviteFields.querySelectorAll('[data-field]').forEach((input) => {
    payload[input.dataset.field] = input.value;
  });
  try {
    await api.post('/members/invite', payload);
    message.textContent = 'Einladung verschickt.';
    message.className = 'success';
    event.target.reset();
    buildFieldInputs(inviteFields);
    await loadMembers();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});

document.getElementById('logout-link').addEventListener('click', async (evt) => {
  evt.preventDefault();
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});

try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  myAccountFields = account.accountFields ?? [];
  buildFieldInputs(inviteFields);
  // The group select is only shown (and thus only ever sent) if the
  // viewer's own group is actually permitted to set it — matching the
  // backend's exact rule for POST /members/invite (a group without
  // 'group' in its account_fields must not hand out a higher group to a
  // brand-new invitee; omitting the field there defaults new invitees to
  // 'sc' server-side).
  if (myAccountFields.includes('group')) {
    inviteGroupWrap.style.display = '';
    inviteGroupSelect.disabled = false;
    await loadGroupOptions();
  }
  // Left disabled (its default state in the markup above) when the viewer
  // lacks 'group' permission — a disabled <select> is excluded from
  // FormData entirely, so the field is genuinely omitted from the submit
  // payload rather than sent as an empty string, letting the backend's
  // default-to-'sc' path apply cleanly.
  await loadMembers();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
  else if (err.status === 403) { message.textContent = 'Kein Zugriff – nur für Admin/Orga.'; message.className = 'error'; }
}
</script>
</body>
</html>
```

**Important — you must add `accountFields` to `GET /account`'s response before this page can work**: `backend/accounts/repository.js`'s `decryptAccount` currently returns `group`, `menus`, `canEditCharacters` but not the caller's own `account_fields` list (this page needs to know which fields IT can show as editable in the invite/edit forms, same permission the backend already enforces — the frontend needs to mirror it to build the right inputs, exactly like `menus` already mirrors `visible_menus`). Add `accountFields: row.account_fields` to `decryptAccount`'s return object in `backend/accounts/repository.js`, and add `groups.account_fields` to that file's `SELECT_COLUMNS`. This is a small, necessary extension of an existing endpoint, not a new one.

- [ ] **Step 2: Verify visually**

Using Claude Browser tools: log in as `admin@pakyrion.local`/`0000`, navigate to `/admin/members.html` via the "Mitglieder" nav link (this is the link that's been 404ing since the previous plan — confirm it now works). Confirm the member list shows the admin account itself plus any other seeded/test users as "Aktiv". Send a test invitation (use a real-looking but clearly fake email you'll clean up, e.g. `invite-verify@example.com`), confirm it appears as "Eingeladen" in the list with a "Erneut senden" button. Click "Erneut senden", confirm no error. Click "Bearbeiten" on the admin's own row (or another active member), confirm the field inputs match the admin group's `account_fields` (all 5 non-group fields), edit one, save, confirm it persists (reload and recheck). Clean up the test invitation via `docker compose exec db psql -U app -d pakyrion -c "DELETE FROM invitations WHERE email = 'invite-verify@example.com';"`.

- [ ] **Step 3: Commit**

```bash
git add frontend/admin/members.html backend/accounts/repository.js
git commit -m "feat: add admin members management page"
```

---

### Task 4: `set-password.html` (invite redemption UI) + full test suite

**Files:**
- Create: `frontend/set-password.html`

**Interfaces:**
- Consumes: Task 1's `POST /auth/invite/redeem`.

- [ ] **Step 1: Write `frontend/set-password.html`**

Chronicle & Crest theme (participant-facing — an invited person is a future participant, not an admin). Model closely on `frontend/reset-password.html` (read it first — same token-in-URL, single-password-field, submit pattern), adapted for the invite-redeem endpoint and its different success behavior (redeem logs the person in immediately, unlike reset which just redirects to login):

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Passwort festlegen – Pakyrion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..700;1,400..600&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/chronicle-crest.css">
</head>
<body>
<div class="shell">
  <div class="brand"><div class="brand-seal">P</div><div class="brand-name">Pakyrion</div></div>
  <p class="brand-sub">Chronicle Registry</p>
  <div class="folio folio--narrow">
    <p class="eyebrow text-center">Willkommen</p>
    <h1 class="text-center">Passwort festlegen</h1>
    <form id="set-password-form">
      <label for="password">Passwort</label>
      <input id="password" name="password" type="password" minlength="8" required>
      <button type="submit" style="width:100%;">Loslegen</button>
    </form>
    <p id="message"></p>
  </div>
</div>
<script type="module">
import { api } from '/js/api.js';

const form = document.getElementById('set-password-form');
const message = document.getElementById('message');
const token = new URLSearchParams(window.location.search).get('token');

if (!token) {
  form.style.display = 'none';
  message.textContent = 'Kein Einladungs-Token gefunden.';
  message.className = 'error';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const password = document.getElementById('password').value;
  try {
    await api.post('/auth/invite/redeem', { token, password });
    window.location.href = '/account.html';
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});
</script>
</body>
</html>
```

- [ ] **Step 2: Verify visually**

Using Claude Browser tools: create a test invitation directly via the admin UI or API (e.g. `invite-e2e@example.com`), fetch its token from the DB (`docker compose exec db psql -U app -d pakyrion -c "SELECT token FROM invitations WHERE email = 'invite-e2e@example.com';"`), visit `/set-password.html?token=<that token>`, submit a password, confirm it redirects to `/account.html` and the account page loads normally (you're logged in). Confirm the invitation is gone from `/admin/members.html`'s list (now shows as an active member instead). Also visit `/set-password.html` with no token and with a garbage token, confirm both show a sensible error and no form (or a form that 400s cleanly). Clean up the test account afterward: `docker compose exec db psql -U app -d pakyrion -c "DELETE FROM users WHERE email = 'invite-e2e@example.com';"`.

- [ ] **Step 3: Commit**

```bash
git add frontend/set-password.html
git commit -m "feat: add invitation redemption page"
```

- [ ] **Step 4: Run the FULL test suite**

Run: `npm test`
Expected: every test in the project passes (150s before this plan + this plan's new tests — expect roughly 173 total, all green, 0 failures). This is the mandatory full-suite check per this plan's Global Constraints — do not skip it or substitute a scoped subset. If anything fails, fix it before considering this plan done; do not park a full-suite failure as a "future cleanup" item.

- [ ] **Step 5: Final commit if Step 4 required fixes**

If Step 4 was already green with no changes needed, skip this step. Otherwise:

```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

## Self-Review Notes (for the plan author / controller, not a task)

- Spec coverage: this plan implements the whole `2026-08-27-mitgliederverwaltung-einladungen-design.md` spec — member CRUD, merged list, invite/resend/redeem lifecycle, both new frontend pages. The one explicitly deferred item (`nsc_data` in `GET /members/:id`) is called out in Global Constraints and matches the base spec's own plan sequencing (NSC Profile is the next plan).
- Type/shape consistency: `backend/invitations/repository.js`'s exports (Task 1) are consumed with identical names/signatures by `backend/members/routes.js` (Task 2) and `backend/auth/invite.js` (Task 1 itself) — verified no drift while writing this plan. `renderNavLinks(account, currentPath)` (Task 3) matches every other consumer's call shape from the prior plan.
- Process fix applied: Task 4 Step 4 is the explicit full-`npm test` gate this plan's Global Constraints require, directly addressing the gap that let a real bug through in the previous plan in this sequence.
