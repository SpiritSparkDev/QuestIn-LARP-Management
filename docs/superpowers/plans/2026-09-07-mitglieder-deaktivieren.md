# Mitglieder deaktivieren Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin/Orga können ein Mitglied deaktivieren (Login gesperrt, Sessions sofort beendet, aus der aktiven Mitgliederliste ausgeblendet) statt es hart zu löschen, und jederzeit wieder reaktivieren.

**Architecture:** Neue nullable Spalte `users.deactivated_at`. Ein zentraler Check in `requireAuth` (der Middleware, die JEDE authentifizierte Route durchläuft) lehnt jede Anfrage eines deaktivierten Accounts ab — das deckt implizit auch Event-Anmeldung, Charakter-Bearbeitung etc. ab, ohne dass jede Route einzeln geändert werden muss. Login (Passwort + OAuth) prüft zusätzlich vor dem Session-Aufbau. Deaktivieren löscht sofort alle Sessions des Ziel-Accounts (harter Logout). Historische Daten (Charaktere, Anmeldungen) bleiben unverändert.

**Tech Stack:** Node.js (kein Framework), PostgreSQL, `node:test`, vanilla JS/HTML Frontend.

**Spec:** Kein separates Spec-Dokument — Design wurde direkt im Chat abgestimmt (bounded-Pfad des brainstorming-Skills). Diese Datei ist die alleinige Quelle der Wahrheit für die Umsetzung.

## Global Constraints

- Nullable `timestamptz`-Spalten für Zustands-Zeitstempel, keine Booleans — konsistent mit `checked_in_at`, `cancelled_at`, `redeemed_at` im bestehenden Schema.
- Jede neue Migration ist eine reine SQL-Datei unter `db/migrations/`, fortlaufend nummeriert (nächste freie Nummer prüfen, aktuell zuletzt `025_teilnehmer_status_lebenszyklus.sql`).
- Jede neue geschützte Route nutzt exakt das bestehende Muster `requireAuth(requireMenu('mitglieder')(async (...) => {...}))`.
- Volle Testsuite (`npm test`) muss am Ende dieses Plans grün sein — als expliziter letzter Schritt, nicht nur pro-Task-Teilmengen.
- Self-Deaktivierung (Admin deaktiviert sich selbst) ist verboten (400).

---

### Task 1: Migration, Repository & Deactivate/Reactivate-Endpunkte

**Files:**
- Create: `db/migrations/026_users_deactivated_at.sql`
- Modify: `backend/members/repository.js`
- Modify: `backend/members/routes.js`
- Test: `tests/integration/members.test.js`

**Interfaces:**
- Produces: `deactivateMember(id)` → `Promise<{id: string} | null>` (repository.js), `reactivateMember(id)` → `Promise<{id: string} | null>` (repository.js), `listMembers(includeDeactivated = false)` (repository.js, signature changed — was `listMembers()`), `POST /members/:id/deactivate`, `POST /members/:id/reactivate` (both `requireAuth(requireMenu('mitglieder')(...))`), `GET /members?includeDeactivated=true` query param.
- Consumes: `withTransaction` from `../db.js` (already used elsewhere, e.g. `backend/auth/invite.js`).

- [ ] **Step 1: Write the migration**

`db/migrations/026_users_deactivated_at.sql`:
```sql
ALTER TABLE users ADD COLUMN deactivated_at timestamptz;
```

- [ ] **Step 2: Modify `backend/members/repository.js`**

Add `users.deactivated_at` to `SELECT_COLUMNS`:
```javascript
const SELECT_COLUMNS = `
  users.id, users.email, users.first_name, users.last_name, users.nickname, users.email_verified, users.deactivated_at,
  users.address_enc, users.birthdate_enc, users.phone_enc, users.emergency_contact_last_name_enc, users.emergency_contact_first_name_enc, users.emergency_contact_phone_enc, users.medical_notes_enc,
  users.con_tage_enc, users.accommodation_enc, users.craft_offer_enc, users.travel_method_enc, users.data_sharing_opt_out_enc, users.photo_opt_out_enc,
  groups.id AS group_id, groups.key AS group_key, groups.name AS group_name
`;
```

Replace the hardcoded `status: 'active'` line in `decryptMember` with a real value derived from the new column:
```javascript
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
```

Change `listMembers` to take an `includeDeactivated` flag (default `false`, preserving today's behavior of showing only active members):
```javascript
export async function listMembers(includeDeactivated = false) {
  const where = includeDeactivated ? '' : 'WHERE users.deactivated_at IS NULL';
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM users JOIN groups ON groups.id = users.group_id ${where} ORDER BY users.last_name, users.first_name`
  );
  return rows.map(decryptMember);
}
```

Add `withTransaction` to the import line at the top of the file:
```javascript
import { query, withTransaction } from '../db.js';
```

Add two new exported functions at the end of the file, after `updateMember`:
```javascript
export async function deactivateMember(id) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'UPDATE users SET deactivated_at = now() WHERE id = $1 RETURNING id',
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

- [ ] **Step 3: Check `withTransaction`'s exact signature before wiring it in**

Run: `grep -n "export async function withTransaction" backend/db.js`
Confirm the callback receives a `client` with its own `.query(sql, params)` method (matching the usage already in `backend/auth/invite.js`). If the signature differs from what Step 2 assumes, adjust Step 2's code to match the real signature — do not guess.

- [ ] **Step 4: Modify `backend/members/routes.js`**

Update the import line to add the two new repository functions:
```javascript
import { listMembers, getMember, updateMember, deactivateMember, reactivateMember } from './repository.js';
```

Change `GET /members` to read the new query param and pass it through:
```javascript
router.get('/members', requireAuth(requireMenu('mitglieder')(async ({ req }) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const includeDeactivated = searchParams.get('includeDeactivated') === 'true';
  const members = await listMembers(includeDeactivated);
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
```

Add two new routes, right after the existing `PATCH /members/:id` route:
```javascript
router.post('/members/:id/deactivate', requireAuth(requireMenu('mitglieder')(async ({ params, user }) => {
  if (params.id === user.id) {
    return { status: 400, body: { error: 'cannot deactivate your own account' } };
  }
  const deactivated = await deactivateMember(params.id);
  if (!deactivated) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: { deactivated: true } };
})));

router.post('/members/:id/reactivate', requireAuth(requireMenu('mitglieder')(async ({ params }) => {
  const reactivated = await reactivateMember(params.id);
  if (!reactivated) return { status: 404, body: { error: 'member not found' } };
  return { status: 200, body: { reactivated: true } };
})));
```

- [ ] **Step 5: Write the failing tests**

Append to `tests/integration/members.test.js` (it already has `makeUserAndSession`, `query`, `createSession`, `createServer` imported and set up — follow its existing raw `createServer().listen(0)` + `try/finally` pattern exactly, do not introduce `withTestServer` into this file):

```javascript
test('POST /members/:id/deactivate blocks login, kills sessions, and hides the member from the default list', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const { userId: targetId, cookie: targetCookie } = await makeUserAndSession('sc');

    const listBefore = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: adminCookie } });
    const membersBefore = await listBefore.json();
    assert.ok(membersBefore.some((m) => m.id === targetId));

    const deactivateRes = await fetch(`http://localhost:${port}/members/${targetId}/deactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(deactivateRes.status, 200);

    // The target's pre-existing session must be dead immediately.
    const meRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: targetCookie } });
    assert.equal(meRes.status, 401);

    // Deactivated members are hidden from the default list...
    const listAfter = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: adminCookie } });
    const membersAfter = await listAfter.json();
    assert.ok(!membersAfter.some((m) => m.id === targetId));

    // ...but visible with includeDeactivated=true, with status 'deactivated'.
    const listIncluding = await fetch(`http://localhost:${port}/members?includeDeactivated=true`, { headers: { Cookie: adminCookie } });
    const membersIncluding = await listIncluding.json();
    const found = membersIncluding.find((m) => m.id === targetId);
    assert.ok(found);
    assert.equal(found.status, 'deactivated');
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate rejects deactivating your own account', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { userId: adminId, cookie: adminCookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/members/${adminId}/deactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate returns 404 for an unknown member', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/members/${crypto.randomUUID()}/deactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /members/:id/reactivate restores login and default-list visibility', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const { userId: targetId } = await makeUserAndSession('sc');

    await fetch(`http://localhost:${port}/members/${targetId}/deactivate`, { method: 'POST', headers: { Cookie: adminCookie } });
    const reactivateRes = await fetch(`http://localhost:${port}/members/${targetId}/reactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(reactivateRes.status, 200);

    const listAfter = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: adminCookie } });
    const membersAfter = await listAfter.json();
    const found = membersAfter.find((m) => m.id === targetId);
    assert.ok(found);
    assert.equal(found.status, 'active');
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate and /reactivate are rejected for a group without the mitglieder menu', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: scCookie } = await makeUserAndSession('sc');
    const { userId: targetId } = await makeUserAndSession('sc');

    const deactivateRes = await fetch(`http://localhost:${port}/members/${targetId}/deactivate`, {
      method: 'POST',
      headers: { Cookie: scCookie },
    });
    assert.equal(deactivateRes.status, 403);

    const reactivateRes = await fetch(`http://localhost:${port}/members/${targetId}/reactivate`, {
      method: 'POST',
      headers: { Cookie: scCookie },
    });
    assert.equal(reactivateRes.status, 403);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 6: Run the migration against the test DB and run the new tests**

Run: `npm run migrate` (or confirm the test file's own `runMigrations()` call picks it up automatically — it does, `tests/integration/members.test.js` calls `runMigrations()` at module load).
Run: `node --test tests/integration/members.test.js`
Expected: all tests pass, including the 5 new ones above.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/026_users_deactivated_at.sql backend/members/repository.js backend/members/routes.js tests/integration/members.test.js
git commit -m "feat: add member deactivate/reactivate with session kill and list filtering"
```

---

### Task 2: Deaktivierte Accounts an Login (Passwort + OAuth) und global via requireAuth blockieren

**Files:**
- Modify: `backend/middleware/authenticate.js`
- Modify: `backend/auth/login.js`
- Modify: `backend/auth/oauth.js`
- Test: `tests/integration/auth-login.test.js`
- Test: `tests/integration/oauth.test.js`
- Test: `tests/integration/middleware.test.js`

**Interfaces:**
- Consumes: `deactivateMember` from `backend/members/repository.js` (Task 1) — tests use it directly to set up a deactivated user, or raw SQL `UPDATE users SET deactivated_at = now() WHERE id = $1` where more convenient.
- Produces: `requireAuth` now rejects any request from a deactivated account with `401 { error: 'account deactivated' }`, even mid-session. `POST /auth/login` returns `403 { error: 'account deactivated' }` for a correct password on a deactivated account. The OAuth callback redirects a deactivated user's login attempt with a `403 { error: 'this account has been deactivated' }` JSON response (matching the existing unverified-email-link rejection shape, not a redirect).

- [ ] **Step 1: Write the failing test for `requireAuth`**

Open `tests/integration/middleware.test.js` and read it first to match its existing style exactly (imports, `makeUserAndSession`-equivalent helper, server setup pattern) before appending. Add a test that:
1. Creates a user + session.
2. Directly sets `deactivated_at = now()` via `UPDATE users SET deactivated_at = now() WHERE id = $1` (raw SQL — Task 1's own deactivate endpoint already deletes the session, which would make this test pass for the wrong reason; setting the column directly, leaving the session row intact, isolates and proves `requireAuth`'s own check).
3. Hits any `requireAuth`-protected endpoint (e.g. `GET /account`) with that still-valid session cookie.
4. Asserts `401`.

```javascript
test('requireAuth rejects a request from a deactivated account even with a still-valid session', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Deactivated', 'Test', (SELECT id FROM groups WHERE key = 'sc'), true) RETURNING id",
      [`deactivated-mw-${crypto.randomUUID()}@example.com`]
    );
    const userId = rows[0].id;
    const session = await createSession(userId);
    await query('UPDATE users SET deactivated_at = now() WHERE id = $1', [userId]);

    const res = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: `session=${session.token}` } });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/integration/middleware.test.js`
Expected: FAIL — the new test gets `200`, not `401` (the check doesn't exist yet).

- [ ] **Step 3: Modify `backend/middleware/authenticate.js`**

Add `users.deactivated_at` to the existing SELECT and reject if set, right after the "not found" check:
```javascript
const { rows } = await query(
  `SELECT users.id, users.email, users.deactivated_at,
          groups.id AS group_id, groups.key AS group_key, groups.name AS group_name,
          groups.visible_menus, groups.account_fields, groups.can_edit_characters,
          groups.character_classes, groups.can_override_checkin_status
   FROM users
   JOIN groups ON groups.id = users.group_id
   WHERE users.id = $1`,
  [session.userId]
);
if (rows.length === 0) return { status: 401, body: { error: 'not authenticated' } };
if (rows[0].deactivated_at) return { status: 401, body: { error: 'account deactivated' } };
```
(The `user` object built below is unchanged — `deactivated_at` is only used for this early-return check, not exposed on `ctx.user`.)

- [ ] **Step 4: Run the test again to verify it passes**

Run: `node --test tests/integration/middleware.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing test for login**

Read `tests/integration/auth-login.test.js` first (it already imports `withTestServer`, has `test.beforeEach(resetRateLimits)`, and a `registerAndVerify(port, email, password)` helper — reuse that helper, don't reinvent registration). Add:

```javascript
test('POST /auth/login rejects a correct password for a deactivated account', async () => {
  await withTestServer(async (port) => {
    const email = `login-deactivated-${crypto.randomUUID()}@example.com`;
    const password = 'correct horse battery staple';
    await registerAndVerify(port, email, password);
    await query('UPDATE users SET deactivated_at = now() WHERE email = $1', [email]);

    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /deactivated/);
  });
});
```

Check the file already imports `query` from `backend/db.js` at the top — if not, add it (match the existing import block's style).

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test tests/integration/auth-login.test.js`
Expected: FAIL — login still succeeds with `200`.

- [ ] **Step 7: Modify `backend/auth/login.js`**

Add `deactivated_at` to the SELECT and check it after password verification succeeds, in the same position as the existing `email_verified` check:
```javascript
const { rows } = await query(
  'SELECT id, password_hash, email_verified, deactivated_at FROM users WHERE email = $1',
  [email]
);
if (rows.length === 0 || !rows[0].password_hash) {
  return { status: 401, body: { error: 'invalid credentials' } };
}

const user = rows[0];
const valid = await verifyPassword(password, user.password_hash);
if (!valid) {
  return { status: 401, body: { error: 'invalid credentials' } };
}
if (user.deactivated_at) {
  return { status: 403, body: { error: 'account deactivated' } };
}
if (!user.email_verified) {
  return { status: 403, body: { error: 'email not verified' } };
}
```

- [ ] **Step 8: Run the login test again to verify it passes**

Run: `node --test tests/integration/auth-login.test.js`
Expected: PASS. Run the whole file, not just the new test, to confirm nothing else broke: `node --test tests/integration/auth-login.test.js` (no filter) should show all tests green.

- [ ] **Step 9: Write the failing test for OAuth**

Read `tests/integration/oauth.test.js` first to find how it already exercises `findOrCreateOAuthUser` / the callback flow (it likely calls `findOrCreateOAuthUser` directly rather than mocking a real provider round-trip — match whatever pattern is already there). Add two tests mirroring the existing "link rejected: unverified email" test's structure:

```javascript
test('findOrCreateOAuthUser rejects a deactivated account already linked to this provider', async () => {
  const email = `oauth-deactivated-linked-${crypto.randomUUID()}@example.com`;
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'OAuth', 'Deactivated', (SELECT id FROM groups WHERE key = 'sc'), true) RETURNING id",
    [email]
  );
  const userId = rows[0].id;
  await query('INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, $2, $3)', [userId, 'google', `provider-id-${crypto.randomUUID()}`]);
  await query('UPDATE users SET deactivated_at = now() WHERE id = $1', [userId]);

  const providerUserId = (await query('SELECT provider_user_id FROM oauth_accounts WHERE user_id = $1', [userId])).rows[0].provider_user_id;
  await assert.rejects(
    () => findOrCreateOAuthUser('google', providerUserId, email, 'OAuth Deactivated', true),
    (err) => err.code === 'OAUTH_ACCOUNT_DEACTIVATED'
  );
});

test('findOrCreateOAuthUser rejects linking a new provider to a deactivated existing account', async () => {
  const email = `oauth-deactivated-link-${crypto.randomUUID()}@example.com`;
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'OAuth', 'Deactivated', (SELECT id FROM groups WHERE key = 'sc'), true) RETURNING id",
    [email]
  );
  await query('UPDATE users SET deactivated_at = now() WHERE id = $1', [rows[0].id]);

  await assert.rejects(
    () => findOrCreateOAuthUser('google', `new-provider-id-${crypto.randomUUID()}`, email, 'OAuth Deactivated', true),
    (err) => err.code === 'OAUTH_ACCOUNT_DEACTIVATED'
  );
});
```

Check the file's existing imports for `findOrCreateOAuthUser` and `query` — add them if missing, matching the existing import style exactly.

- [ ] **Step 10: Run it to verify it fails**

Run: `node --test tests/integration/oauth.test.js`
Expected: FAIL — both new tests get a resolved promise instead of a rejection (no `OAUTH_ACCOUNT_DEACTIVATED` check exists yet).

- [ ] **Step 11: Modify `backend/auth/oauth.js`**

In `findOrCreateOAuthUser`, add the deactivation check to both existing-account lookup paths:
```javascript
export async function findOrCreateOAuthUser(providerName, providerUserId, email, name, emailVerifiedByProvider) {
  const normalizedEmail = email.toLowerCase();

  const existingOAuth = await query(
    `SELECT oauth_accounts.user_id, users.deactivated_at
     FROM oauth_accounts JOIN users ON users.id = oauth_accounts.user_id
     WHERE oauth_accounts.provider = $1 AND oauth_accounts.provider_user_id = $2`,
    [providerName, providerUserId]
  );
  if (existingOAuth.rows.length > 0) {
    if (existingOAuth.rows[0].deactivated_at) {
      const err = new Error('oauth account deactivated');
      err.code = 'OAUTH_ACCOUNT_DEACTIVATED';
      throw err;
    }
    return existingOAuth.rows[0].user_id;
  }

  const existingUser = await query('SELECT id, deactivated_at FROM users WHERE email = $1', [normalizedEmail]);
  let userId;
  if (existingUser.rows.length > 0) {
    if (existingUser.rows[0].deactivated_at) {
      const err = new Error('oauth account deactivated');
      err.code = 'OAUTH_ACCOUNT_DEACTIVATED';
      throw err;
    }
    if (!emailVerifiedByProvider) {
      const err = new Error('oauth email not verified by provider, cannot link to an existing account');
      err.code = 'OAUTH_EMAIL_NOT_VERIFIED';
      throw err;
    }
    userId = existingUser.rows[0].id;
  } else {
    const { firstName, lastName } = splitFullName(name || normalizedEmail);
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, group_id, first_name, last_name, email_verified)
       VALUES ($1, NULL, (SELECT id FROM groups WHERE key = 'sc'), $2, $3, $4) RETURNING id`,
      [normalizedEmail, firstName, lastName, !!emailVerifiedByProvider]
    );
    userId = rows[0].id;
  }

  await query(
    'INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, $2, $3)',
    [userId, providerName, providerUserId]
  );
  return userId;
}
```

In the `/auth/oauth/:provider/callback` route handler, add a new `catch` branch right after the existing `OAUTH_EMAIL_NOT_VERIFIED` one:
```javascript
} catch (err) {
  if (err.code === 'OAUTH_EMAIL_NOT_VERIFIED') {
    logger.info('oauth link rejected: unverified email', { provider: params.provider });
    return {
      status: 409,
      body: { error: 'this email is not verified by the provider and cannot be linked to an existing account' },
      headers: { 'Set-Cookie': clearStateCookie },
    };
  }
  if (err.code === 'OAUTH_ACCOUNT_DEACTIVATED') {
    logger.info('oauth login rejected: account deactivated', { provider: params.provider });
    return {
      status: 403,
      body: { error: 'this account has been deactivated' },
      headers: { 'Set-Cookie': clearStateCookie },
    };
  }
  throw err;
}
```

- [ ] **Step 12: Run the OAuth tests again to verify they pass**

Run: `node --test tests/integration/oauth.test.js`
Expected: PASS, whole file.

- [ ] **Step 13: Run the full test suite**

Run: `npm test`
Expected: every test passes. This step exists specifically because a deactivated-account check that's too aggressive (e.g. misplaced logic, wrong column reference) tends to break unrelated tests elsewhere that create users via raw SQL without ever setting `deactivated_at` (should default to `NULL`, i.e. active) — a full run is the only way to catch that.

- [ ] **Step 14: Commit**

```bash
git add backend/middleware/authenticate.js backend/auth/login.js backend/auth/oauth.js tests/integration/middleware.test.js tests/integration/auth-login.test.js tests/integration/oauth.test.js
git commit -m "fix: block login and every authenticated request for deactivated accounts"
```

**Note for the task reviewer:** this plan deliberately does NOT add a separate deactivated-check to `POST /events/:id/register`. Since `requireAuth` (Step 3 above) now rejects every authenticated request for a deactivated account — including that endpoint — a deactivated user can never reach it in the first place. Verify this claim rather than trusting it: write (or confirm Step 13's full suite already proves) that a deactivated user hitting `POST /events/:id/register` gets `401`, not `403`/`200`. If you find a path where `requireAuth` is bypassed for that route, that's a real gap — flag it, don't silently add a redundant check without understanding why the central one didn't already catch it.

---

### Task 3: Frontend — Deaktivieren/Reaktivieren auf `admin/members.html`

**Files:**
- Modify: `frontend/admin/members.html`

**Interfaces:**
- Consumes: `POST /members/:id/deactivate`, `POST /members/:id/reactivate`, `GET /members?includeDeactivated=true` (all from Task 1).

- [ ] **Step 1: Add a view-toggle above the member table**

In the HTML, right after the `<button type="button" id="invite-open">Neues Mitglied anlegen</button>` line, add:
```html
<div class="toggle-group toggle-group-sm" style="margin:16px 0 0;">
  <button type="button" class="toggle-btn active" data-view="active">Aktive Mitglieder</button>
  <button type="button" class="toggle-btn" data-view="deactivated">Deaktivierte Mitglieder</button>
</div>
```
(`.toggle-group`/`.toggle-btn` already exist in `frontend/css/everest-registry.css` and are already used the same way on `frontend/admin/checkin.html`'s scan-mode switch — no new CSS needed.)

- [ ] **Step 2: Track the current view and the logged-in user's own id**

Near the other top-of-script `let` declarations (`let myAccountFields = [];` / `let editingMemberId = null;`), add:
```javascript
let currentView = 'active';
let myUserId = null;
```

- [ ] **Step 3: Wire the toggle buttons**

Add, near the other top-level `document.getElementById(...).addEventListener` calls (e.g. right after the `invite-open`/`invite-cancel` listeners):
```javascript
document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (currentView === btn.dataset.view) return;
    currentView = btn.dataset.view;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b === btn));
    loadMembers();
  });
});
```

- [ ] **Step 4: Rewrite `loadMembers` to respect the current view and render deactivate/reactivate controls**

Replace the whole `loadMembers` function with:
```javascript
async function loadMembers() {
  const members = await api.get(`/members${currentView === 'deactivated' ? '?includeDeactivated=true' : ''}`);
  const visible = currentView === 'deactivated'
    ? members.filter((m) => m.status === 'deactivated')
    : members.filter((m) => m.status !== 'deactivated');

  listBody.innerHTML = visible.map((m) => {
    let statusCell;
    let actionsCell;
    if (m.status === 'active') {
      statusCell = `<span class="badge badge-active">Aktiv</span>`;
      const deactivateBtn = m.id === myUserId
        ? ''
        : `<button type="button" class="btn-sm btn-ghost" data-deactivate="${m.id}">Deaktivieren</button>`;
      actionsCell = `<button type="button" class="btn-sm btn-ghost" data-edit="${m.id}">Bearbeiten</button> ${deactivateBtn}`;
    } else if (m.status === 'deactivated') {
      statusCell = `<span class="badge badge-inactive">Deaktiviert</span>`;
      actionsCell = `<button type="button" class="btn-sm btn-ghost" data-reactivate="${m.id}">Reaktivieren</button>`;
    } else {
      statusCell = `<span class="badge badge-inactive">Eingeladen${m.expired ? ' (abgelaufen)' : ''}</span>`;
      actionsCell = `<button type="button" class="btn-sm btn-ghost" data-resend="${m.id}">Erneut senden</button>
         <button type="button" class="btn-sm btn-ghost" data-cancel-invite="${m.id}">Absagen</button>`;
    }
    return `<tr>
    <td>${escapeHtml(m.name)}</td>
    <td>${escapeHtml(m.email)}</td>
    <td>${escapeHtml(m.group?.name ?? '–')}</td>
    <td>${statusCell}</td>
    <td>${actionsCell}</td>
  </tr>`;
  }).join('');

  listBody.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => openDetail(button.dataset.edit));
  });
  listBody.querySelectorAll('[data-resend]').forEach((button) => {
    button.addEventListener('click', () => resendInvitation(button.dataset.resend));
  });
  listBody.querySelectorAll('[data-cancel-invite]').forEach((button) => {
    button.addEventListener('click', () => cancelInvite(button.dataset.cancelInvite));
  });
  listBody.querySelectorAll('[data-deactivate]').forEach((button) => {
    button.addEventListener('click', () => deactivateMemberRow(button.dataset.deactivate));
  });
  listBody.querySelectorAll('[data-reactivate]').forEach((button) => {
    button.addEventListener('click', () => reactivateMemberRow(button.dataset.reactivate));
  });
}
```

- [ ] **Step 5: Add the deactivate/reactivate action functions**

Add these two new functions right after the existing `cancelInvite` function:
```javascript
async function deactivateMemberRow(id) {
  if (!confirm('Mitglied wirklich deaktivieren? Der Login wird gesperrt und alle aktiven Sitzungen werden sofort beendet.')) return;
  message.textContent = '';
  message.className = '';
  try {
    await api.post(`/members/${id}/deactivate`, {});
    message.textContent = 'Mitglied deaktiviert.';
    message.className = 'success';
    await loadMembers();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
}

async function reactivateMemberRow(id) {
  message.textContent = '';
  message.className = '';
  try {
    await api.post(`/members/${id}/reactivate`, {});
    message.textContent = 'Mitglied reaktiviert.';
    message.className = 'success';
    await loadMembers();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
}
```

- [ ] **Step 6: Capture the logged-in user's own id at page load**

In the final `try { const account = await api.get('/account'); ... }` block at the bottom of the script, add one line right after `myAccountFields = account.accountFields ?? [];`:
```javascript
myUserId = account.id;
```

- [ ] **Step 7: Manual verification**

Start the dev stack (`docker compose up` or however this project's Docker workflow normally runs — check `docker-compose.yml`/existing container names first rather than assuming) and open `admin/members.html` as an admin/orga user in the Browser tool:
1. Confirm the "Aktive Mitglieder" / "Deaktivierte Mitglieder" toggle renders and switches the list.
2. Deactivate a non-self test member; confirm the confirm() dialog appears, the row disappears from the active list, and appears under "Deaktivierte Mitglieder" with a "Reaktivieren" button.
3. Confirm your OWN row never shows a "Deaktivieren" button.
4. Reactivate the member; confirm it reappears under "Aktive Mitglieder".
5. In a second browser tab/incognito session, confirm a deactivated member's login attempt fails with a clear error, and that the app doesn't crash for a member whose session was live when they got deactivated (should be logged out on next request).

- [ ] **Step 8: Commit**

```bash
git add frontend/admin/members.html
git commit -m "feat: add deactivate/reactivate UI to admin/members.html"
```

---

### Task 4: Full test suite

**Files:** None (verification-only task).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test in the project passes. Mandatory final gate — do not skip even if every individual task already ran its own scoped tests.

- [ ] **Step 2: Commit if Step 1 required fixes**

If Step 1 was already green, skip this step. Otherwise:
```bash
git add -A
git commit -m "fix: address full-suite failures found after member deactivation work"
```
