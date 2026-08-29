# Technische Schulden Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two long-standing, previously-deferred technical debts: a leaked-HTTP-server pattern across most of the integration test suite (a thrown assertion before `server.close()` leaves the server open, which can hang `node --test`), and the `groups` table's `role`→`group_id` finalization DDL living in a seed script instead of a real, transaction-protected migration.

**Architecture:** A tiny shared test helper (`tests/testServer.js`, `withTestServer(async (port) => {...})`) that guarantees `server.close()` via `finally`, adopted mechanically across every integration test file that still uses the bare `const server = createServer().listen(0); ... server.close();` pattern. Separately, a new migration (`014_finalize_group_id.sql`) takes over the `role`→`group_id` backfill and `DROP COLUMN role` that `db/seedGroups.js` currently performs as raw, unprotected DDL — written so it's a correct no-op on every database that already ran this logic via the old seed-script path, and correct on a genuinely fresh database too.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, `pg`, vanilla JS frontend, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-28-charakterklassen-und-hardening-design.md` (Abschnitt 5 "Technische Schulden")

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step — standing rule for every plan in this sequence.
- The 5 integration test files that ALREADY correctly use `try/finally` around every `server.close()` call (`tests/integration/groups.test.js`, `tests/integration/members.test.js`, `tests/integration/nscSchema.test.js`, `tests/integration/invitations.test.js`, and any test within a "mixed" file that already uses `try/finally`) must NOT be touched if they're already correct — only genuinely bare `server.close()` call sites get converted. Don't rewrite what's already right.
- Every test's assertions, test name, and behavior must be preserved EXACTLY — this is a pure setup/teardown refactor, never a behavior change. If a test currently asserts X, it must still assert X after conversion, word for word.
- The new migration must be safe to run BOTH on a genuinely fresh database (where `groups` is empty and `users.role` still exists) AND on every database that has already run the current `db/seedGroups.js` logic (where `users.role` no longer exists) — it must be a correct no-op in the second case.
- `db/seedGroups.js` keeps its idempotent `INSERT ... ON CONFLICT (key) DO NOTHING` seeding loop exactly as-is; only the backfill+DDL block is removed from it.
- Every existing test must still pass; verify with each task's specified scope before the final full-suite gate.

---

### Task 1: `withTestServer` helper + convert the two smallest files

**Files:**
- Create: `tests/testServer.js`
- Modify: `tests/integration/server.test.js`
- Modify: `tests/integration/staticFiles.test.js`

**Interfaces:**
- Produces: `export async function withTestServer(fn)` from `tests/testServer.js` — calls `fn(port)` where `port` is the ephemeral port a freshly-created `createServer().listen(0)` bound to, and guarantees `server.close()` runs in a `finally` regardless of how `fn` completes (returns, throws, or an assertion inside it throws). Returns whatever `fn` returns. Consumed by every later task in this plan.

- [ ] **Step 1: Create the helper**

Create `tests/testServer.js`:

```javascript
import { createServer } from '../backend/server.js';

export async function withTestServer(fn) {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    return await fn(port);
  } finally {
    server.close();
  }
}
```

- [ ] **Step 2: Convert `tests/integration/server.test.js`**

Replace the entire file:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { router } = await import('../../backend/server.js');
const { closePool } = await import('../../backend/db.js');

test('GET /health returns ok and a request id header', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ok' });
    assert.ok(res.headers.get('x-request-id'));
  });
});

test('unknown route returns 404 with a request id', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.requestId);
  });
});

test('a handler that throws produces a generic 500 without leaking internals', async () => {
  router.get('/__boom', async () => { throw new Error('kaboom internal detail'); });
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/__boom`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'internal server error');
    assert.ok(body.requestId);
    assert.ok(!JSON.stringify(body).includes('kaboom'));
  });
});

test('a handler returning a non-serializable body produces a generic 500 instead of crashing', async () => {
  router.get('/__unserializable', async () => ({ status: 200, body: { bad: 10n } }));
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/__unserializable`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'internal server error');
  });
});

test.after(async () => {
  await closePool();
});
```

(Note: `createServer` is no longer imported directly in this file — `withTestServer` owns that. `router` is still imported directly since two tests register routes on it before calling `withTestServer`.)

- [ ] **Step 3: Convert `tests/integration/staticFiles.test.js`**

Replace the entire file:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { closePool } = await import('../../backend/db.js');

const FRONTEND_DIR = path.join(process.cwd(), 'frontend');

test('GET / serves frontend/index.html', async () => {
  // Assert against the real committed index.html rather than writing a fixture
  // over it — an earlier version of this test unlinked the file afterwards and
  // destroyed it on every `npm test` run.
  const expected = await readFile(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), expected);
  });
});

test('GET /does-not-exist.html returns 404, not a crash', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/does-not-exist.html`);
    assert.equal(res.status, 404);
  });
});

test('an unmatched API-shaped path still returns the normal JSON 404', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.requestId);
  });
});

test.after(async () => {
  await closePool();
});
```

(Note: `createServer` is no longer imported directly — `withTestServer` owns it. `path.join(process.cwd(), 'frontend')` and the `readFile` call stay exactly as they were, unrelated to this refactor.)

- [ ] **Step 4: Run the tests**

Run: `node --test tests/integration/server.test.js tests/integration/staticFiles.test.js`
Expected: all PASS (7 tests total, same assertions as before, just restructured).

- [ ] **Step 5: Commit**

```bash
git add tests/testServer.js tests/integration/server.test.js tests/integration/staticFiles.test.js
git commit -m "feat: add withTestServer helper, convert server.test.js and staticFiles.test.js"
```

---

### Task 2: Convert `events.test.js` and `registrations.test.js`

**Files:**
- Modify: `tests/integration/events.test.js`
- Modify: `tests/integration/registrations.test.js`

**Interfaces:**
- Consumes: `withTestServer(fn)` from Task 1.

This is a **mechanical, 1:1 transformation** applied to every test in both files — no logic, assertion, or test name changes, only the setup/teardown restructuring. The rule, demonstrated below with one complete worked example per file:

**The rule:** every test currently shaped like:
```javascript
test('name', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  // ...body using port...
  server.close();
});
```
becomes:
```javascript
test('name', async () => {
  await withTestServer(async (port) => {
    // ...body using port, completely unchanged...
  });
});
```
Every line between the old `const { port } = server.address();` and the old `server.close();` moves inside the new arrow function, completely unchanged (same variable names, same assertions, same order). Delete the old `const server = ...` and `server.close();` lines. If a test declares helper functions inline that close over `port` (e.g. `async function createEvent(name) { ... uses port ... }` in `events.test.js`), that inner function moves inside `withTestServer`'s callback along with everything else that references `port`.

- [ ] **Step 1: Convert `tests/integration/events.test.js`**

Change the import block. Replace:
```javascript
const { createServer } = await import('../../backend/server.js');
const { query, closePool } = await import('../../backend/db.js');
```
with:
```javascript
const { query, closePool } = await import('../../backend/db.js');
```
and add near the top of the file (after the other `import` lines, before the `process.env` block):
```javascript
import { withTestServer } from '../testServer.js';
```

Then apply the mechanical rule above to EVERY ONE of the 7 tests in this file. Worked example — the first test, `'admin can create an event; participant cannot'`, converts from:

```javascript
test('admin can create an event; participant cannot', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const admin = await makeUserAndSession('admin');
  const participant = await makeUserAndSession('sc');
  const payload = {
    name: 'Sommercon 2027',
    eventDate: '2027-07-15',
    characterFormSchema: [{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }],
  };

  const asAdmin = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify(payload),
  });
  assert.equal(asAdmin.status, 201);
  const created = await asAdmin.json();
  assert.equal(created.name, 'Sommercon 2027');
  assert.equal(created.event_date, '2027-07-15');

  const asParticipant = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify(payload),
  });
  assert.equal(asParticipant.status, 403);

  server.close();
});
```

to:

```javascript
test('admin can create an event; participant cannot', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const participant = await makeUserAndSession('sc');
    const payload = {
      name: 'Sommercon 2027',
      eventDate: '2027-07-15',
      characterFormSchema: [{ key: 'fraction', label: 'Fraktion', type: 'text', required: true }],
    };

    const asAdmin = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify(payload),
    });
    assert.equal(asAdmin.status, 201);
    const created = await asAdmin.json();
    assert.equal(created.name, 'Sommercon 2027');
    assert.equal(created.event_date, '2027-07-15');

    const asParticipant = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify(payload),
    });
    assert.equal(asParticipant.status, 403);
  });
});
```

Apply this identical pattern to the remaining 6 tests in the file: `'any authenticated user can list and get events; unknown id is 404'`, `'admin can update an event\'s character form schema'`, `'admin creating an event with a malformed characterFormSchema gets 400'`, `'GET /events/:id with a malformed UUID returns 400, not 500'`, `'admin can activate an event; activating one deactivates all others; participant cannot activate'` (this one has the inline `async function createEvent(name) {...}` helper referencing `port` — move it inside the `withTestServer` callback, before its first use), and `'PUT /events/:id rejects a characterFormSchema using the reserved key "id" or "name"'`. Read the file's current content for each test's exact body before converting it — don't reconstruct from memory.

- [ ] **Step 2: Convert `tests/integration/registrations.test.js`**

Same import change: remove `createServer` from the `backend/server.js` import, add `import { withTestServer } from '../testServer.js';` near the top.

Worked example — the first test, `'a participant can register and unregister for an event'`, converts from:

```javascript
test('a participant can register and unregister for an event', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { userId, cookie } = await makeUserAndSession();
  const eventId = await makeEvent();

  const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(registerRes.status, 201);
  const registration = await registerRes.json();
  assert.equal(registration.status, 'registered');

  const dupRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(dupRes.status, 409);

  const unregisterRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(unregisterRes.status, 200);

  const { rows } = await query(
    'SELECT * FROM registrations WHERE user_id = $1 AND event_id = $2',
    [userId, eventId]
  );
  assert.equal(rows.length, 0);

  server.close();
});
```

to:

```javascript
test('a participant can register and unregister for an event', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assert.equal(registerRes.status, 201);
    const registration = await registerRes.json();
    assert.equal(registration.status, 'registered');

    const dupRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assert.equal(dupRes.status, 409);

    const unregisterRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(unregisterRes.status, 200);

    const { rows } = await query(
      'SELECT * FROM registrations WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );
    assert.equal(rows.length, 0);
  });
});
```

Apply this identical pattern to the remaining 5 tests: `'registering for an unknown event returns 404'`, `'unregistering without an existing registration returns 404'`, `'a checked-in participant cannot unregister'`, `'concurrent check-in and unregister never leave an inconsistent row'` (this test does two `Promise.all`-wrapped fetches referencing `port` inside inline arrow functions — those arrow functions move inside the `withTestServer` callback along with everything else), and `'GET /registrations lists only the calling participant\'s registrations'`. Read the file's current content for each test's exact body before converting it.

- [ ] **Step 3: Run the tests**

Run: `node --test tests/integration/events.test.js tests/integration/registrations.test.js`
Expected: all PASS (13 tests total, same assertions as before).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/events.test.js tests/integration/registrations.test.js
git commit -m "feat: convert events.test.js and registrations.test.js to withTestServer"
```

---

### Task 3: Convert `checkin.test.js`

**Files:**
- Modify: `tests/integration/checkin.test.js`

**Interfaces:**
- Consumes: `withTestServer(fn)` from Task 1.

Same mechanical rule as Task 2, applied to all 12 tests in this file. Change the import block the same way (remove `createServer` from the `backend/server.js` import, add `import { withTestServer } from '../testServer.js';`).

Worked example — the first test, `'a participant cannot list participants or check anyone in'`, converts from:

```javascript
test('a participant cannot list participants or check anyone in', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const { cookie } = await makeUserAndSession('sc');
  const eventId = await makeEvent();

  const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: cookie } });
  assert.equal(listRes.status, 403);

  const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ userId: crypto.randomUUID() }),
  });
  assert.equal(checkinRes.status, 403);

  const checkoutRes = await fetch(`http://localhost:${port}/events/${eventId}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ userId: crypto.randomUUID() }),
  });
  assert.equal(checkoutRes.status, 403);

  server.close();
});
```

to:

```javascript
test('a participant cannot list participants or check anyone in', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('sc');
    const eventId = await makeEvent();

    const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 403);

    const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    assert.equal(checkinRes.status, 403);

    const checkoutRes = await fetch(`http://localhost:${port}/events/${eventId}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    assert.equal(checkoutRes.status, 403);
  });
});
```

Apply this identical pattern to all remaining 11 tests in the file: `'checkin_helper sees the participant list with characters and no encrypted fields, then checks someone in and out'`, `'GET /events/:id/participants for an unknown event returns 404'`, `'checking in a user with no registration for the event returns 404'`, `'two concurrent check-ins for the same attendee: exactly one succeeds'` (has a `Promise.all`-wrapped inline arrow function referencing `port` — moves inside the callback), `'a user without canOverrideCheckinStatus cannot use the override endpoint'`, `'a user with canOverrideCheckinStatus can set a status directly, including a backward transition'`, `'overriding to checked_out preserves an already-set checked_in_at instead of overwriting it'`, `'the override endpoint rejects an invalid status value'`, `'the override endpoint returns 404 for a user with no registration for the event'`, `'two concurrent overrides on the same registration with the same previousStatus: exactly one succeeds'` (same `Promise.all` pattern), and `'the normal checkin/checkout flow still works unchanged alongside the override endpoint'`. Read the file's current content for each test's exact body before converting it.

- [ ] **Step 1: Run the tests**

Run: `node --test tests/integration/checkin.test.js`
Expected: all PASS (12 tests, same assertions as before).

- [ ] **Step 2: Commit**

```bash
git add tests/integration/checkin.test.js
git commit -m "feat: convert checkin.test.js to withTestServer"
```

---

### Task 4: Convert `characters.test.js`

**Files:**
- Modify: `tests/integration/characters.test.js`

**Interfaces:**
- Consumes: `withTestServer(fn)` from Task 1.

Same mechanical rule as Tasks 2-3, applied to all 11 tests in this file. Change the import block the same way.

Worked example — the first test, `'creating a character validates against the event schema'`, converts from:

```javascript
test('creating a character validates against the event schema', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const participant = await makeUserAndSession();
  const eventId = await makeEvent();

  const missingRequired = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify({ eventId, name: 'Aldric', data: {} }),
  });
  assert.equal(missingRequired.status, 400);

  const ok = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify({ eventId, name: 'Aldric', data: { fraction: 'Nordmark' } }),
  });
  assert.equal(ok.status, 201);
  const created = await ok.json();
  assert.equal(created.name, 'Aldric');

  const unknownEvent = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
    body: JSON.stringify({ eventId: crypto.randomUUID(), name: 'Ghost', data: {} }),
  });
  assert.equal(unknownEvent.status, 404);

  server.close();
});
```

to:

```javascript
test('creating a character validates against the event schema', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();
    const eventId = await makeEvent();

    const missingRequired = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId, name: 'Aldric', data: {} }),
    });
    assert.equal(missingRequired.status, 400);

    const ok = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId, name: 'Aldric', data: { fraction: 'Nordmark' } }),
    });
    assert.equal(ok.status, 201);
    const created = await ok.json();
    assert.equal(created.name, 'Aldric');

    const unknownEvent = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ eventId: crypto.randomUUID(), name: 'Ghost', data: {} }),
    });
    assert.equal(unknownEvent.status, 404);
  });
});
```

Apply this identical pattern to all remaining 10 tests: `'a participant only sees their own characters in the list'`, `'a participant cannot view or edit another participant\'s character; an admin can view but not edit it'`, `'PUT /characters/:id validates data against the event schema'`, `'a participant cannot create a character for an inactive event; an admin can'`, `'an sl-group user cannot create a character for an inactive event'`, `'creating an nsc-class character validates against the current nsc_profile_schema, not an event'`, `'an nsc-class character request with an eventId is rejected'`, `'a group without nsc character-class access cannot create an nsc-class character'`, `'a user can create multiple sc-class characters for the same event (Ersatzcharaktere)'`, and `'PUT on an nsc-class character validates against the current nsc_profile_schema'`. Read the file's current content for each test's exact body before converting it.

- [ ] **Step 1: Run the tests**

Run: `node --test tests/integration/characters.test.js`
Expected: all PASS (11 tests, same assertions as before).

- [ ] **Step 2: Commit**

```bash
git add tests/integration/characters.test.js
git commit -m "feat: convert characters.test.js to withTestServer"
```

---

### Task 5: Convert the 5 mixed auth-adjacent files

**Files:**
- Modify: `tests/integration/auth-register.test.js`
- Modify: `tests/integration/auth-login.test.js`
- Modify: `tests/integration/auth-password-reset.test.js`
- Modify: `tests/integration/oauth.test.js`
- Modify: `tests/integration/accounts.test.js`

**Interfaces:**
- Consumes: `withTestServer(fn)` from Task 1.

These 5 files are DIFFERENT from Tasks 2-4: each already has SOME tests correctly wrapped in `try { ... } finally { server.close(); }` (added by an earlier plan in this sequence for the rate-limiting feature), mixed together with OLDER tests that still use the bare `const server = createServer().listen(0); ... server.close();` pattern with no protection at all.

**The rule for this task:**
- Any test ALREADY using `try { ... } finally { server.close(); }` — leave it completely untouched. Do not convert it to `withTestServer`, do not touch it at all. It's already correct.
- Any test still using the bare pattern (`const server = createServer().listen(0); const { port } = server.address(); ...body...; server.close();` with no `try`/`finally` around it) — convert it using the exact same mechanical rule from Task 2/3/4: everything between `server.address()` and `server.close()` moves inside a `withTestServer(async (port) => {...})` callback, the `const server = ...`/`server.close()` lines are deleted.

Read each of these 5 files' CURRENT full content first (they've all been modified by other plans in this sequence — don't assume any prior read of these files in this conversation still reflects their current state) and identify which tests are already-guarded vs. still-bare before converting anything.

- [ ] **Step 1: Convert `tests/integration/auth-register.test.js`**

Add `import { withTestServer } from '../testServer.js';` near the top of the file. Convert every still-bare test using the mechanical rule above; leave every already-`try`/`finally`-guarded test untouched. If, after converting the bare tests, `createServer` is no longer referenced directly anywhere in the file outside of `withTestServer`'s own module, remove the now-unused `createServer` import/destructure; if any already-guarded test still calls `createServer()` directly itself (rather than through `withTestServer`), keep the import.

- [ ] **Step 2: Convert `tests/integration/auth-login.test.js`**

Same approach: add the import, convert every still-bare test, leave every already-guarded test (including the two rate-limiting tests from an earlier plan, which use a deliberate `127.0.0.1`-vs-`localhost` distinction — do not alter their target hostnames, only their server-lifecycle shape if they're not already using `try`/`finally`; check first, they may already be correctly guarded) untouched.

- [ ] **Step 3: Convert `tests/integration/auth-password-reset.test.js`**

Same approach.

- [ ] **Step 4: Convert `tests/integration/oauth.test.js`**

Same approach.

- [ ] **Step 5: Convert `tests/integration/accounts.test.js`**

Same approach.

- [ ] **Step 6: Run the tests**

Run: `node --test --test-concurrency=1 tests/integration/auth-register.test.js tests/integration/auth-login.test.js tests/integration/auth-password-reset.test.js tests/integration/oauth.test.js tests/integration/accounts.test.js`

(Use `--test-concurrency=1` explicitly — running these 5 files together without it can spuriously race on shared-DB migrations, an unrelated pre-existing characteristic of this test suite, not something this task's changes cause.)

Expected: all PASS, same assertions as before in every test.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/auth-register.test.js tests/integration/auth-login.test.js tests/integration/auth-password-reset.test.js tests/integration/oauth.test.js tests/integration/accounts.test.js
git commit -m "feat: convert remaining mixed auth test files to withTestServer"
```

---

### Task 6: Move groups DDL into a real migration; full test suite

**Files:**
- Create: `db/migrations/014_finalize_group_id.sql`
- Modify: `db/seedGroups.js`
- Modify: `tests/integration/seedGroups.test.js`

**Interfaces:**
- No new exports — this task changes internal seeding/migration mechanics, not any public interface other code depends on.

- [ ] **Step 1: Write the migration**

Create `db/migrations/014_finalize_group_id.sql`. This inserts the 8 default groups directly (needed because on a genuinely fresh database, this migration runs BEFORE `db/seedGroups.js` ever executes — migrations and seeding are separate commands in `docker-compose.yml`'s startup chain, migrations always complete first) and conditionally backfills+finalizes `users.role`→`group_id` only if the `role` column still exists (a no-op on every database where `db/seedGroups.js` already did this, which includes this project's own dev database):

```sql
INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, character_classes, can_override_checkin_status, is_protected)
VALUES
  ('admin', 'Admin', '["konto","charaktere","mitglieder","events","checkin"]'::jsonb, '["address","birthdate","phone","emergencyContact","medicalNotes","pronomen","group"]'::jsonb, true, '["sc"]'::jsonb, true, true),
  ('orga', 'Orga', '["konto","charaktere","mitglieder","events","checkin"]'::jsonb, '["address","birthdate","phone","emergencyContact","medicalNotes","pronomen"]'::jsonb, true, '["sc"]'::jsonb, true, false),
  ('plot_orga', 'Plot-Orga', '["konto","charaktere","events","checkin"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, false, false),
  ('sl', 'SL', '["konto","charaktere","checkin"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, true, false),
  ('hilfs_sl', 'Hilfs-SL', '["konto","charaktere","checkin"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, false, false),
  ('nsc', 'NSC', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, '["nsc"]'::jsonb, false, false),
  ('gsc', 'GSC', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, false, false),
  ('sc', 'SC', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, false, false)
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role') THEN
    UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'admin') WHERE role = 'admin' AND group_id IS NULL;
    UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'sl') WHERE role = 'checkin_helper' AND group_id IS NULL;
    UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'sc') WHERE role = 'participant' AND group_id IS NULL;
    ALTER TABLE users ALTER COLUMN group_id SET NOT NULL;
    ALTER TABLE users DROP COLUMN role;
  END IF;
END $$;
```

(The 8 rows here must match `db/groupDefaults.js`'s `GROUP_DEFAULTS` array exactly — this is the same "duplicate the data once, in a migration, so it's independent of seed-script execution order" tradeoff already used by this project's `009_pronomen_field.sql`/`010_group_character_classes.sql`/`013_checkin_status_override.sql` migrations for their own retroactive grants, just applied here to the initial insert itself since this migration can run before any seed script.)

- [ ] **Step 2: Simplify `db/seedGroups.js`**

Replace the entire file — removes the backfill loop and the two `ALTER TABLE` calls, keeps the INSERT loop exactly as-is:

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

- [ ] **Step 3: Rewrite `tests/integration/seedGroups.test.js`'s backfill test to exercise the migration instead**

Read the current file first. The existing first test (`'backfills group_id for a user with an existing role value, then drops the role column'`) currently calls `seedGroups()` to exercise the backfill — after Step 2, `seedGroups()` no longer does that, so this test needs to exercise `runMigrations()` instead. Since migrations only ever run once per filename (tracked in the `schema_migrations` table), re-exercising migration 014's backfill path means removing its own tracking row first, then restoring the pre-migration schema shape, then calling `runMigrations()` again so only that one file re-applies.

Replace the entire file:

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

// This file's schema-mutating setup (re-adding the `role` column, relaxing
// group_id NOT NULL, and re-running migration 014) is only safe because
// package.json's `test` script runs with --test-concurrency=1 (sequential
// file execution). Without that flag this would race with other test
// files' runMigrations()/seedGroups() calls against the same shared DB.

// The shared test DB is not reset between runs (tmpfs, only cleared on
// container restart), so a prior run may have already applied migration
// 014 and dropped `role`. Restore both (matching users' original shape from
// 001_users_and_sessions.sql) so the backfill test below always has a
// role-bearing column to exercise, regardless of what earlier runs did.
const { rows: roleColumn } = await query(
  `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`
);
if (roleColumn.length === 0) {
  await query(
    `ALTER TABLE users ADD COLUMN role text not null default 'participant' check (role in ('participant', 'admin', 'checkin_helper'))`
  );
  // A prior finalization also set group_id NOT NULL; relax it back so a
  // role-only insert (no group_id yet) is legal again, matching the
  // pre-finalization schema the migration expects to backfill.
  await query('ALTER TABLE users ALTER COLUMN group_id DROP NOT NULL');
}

// This test must run first (before any other test in this file calls
// seedGroups()) — only at this point does the `role` column still exist,
// so it's the only place the real backfill path is exercised rather than
// the "already finalized, role column absent" no-op path.
test('migration 014 backfills group_id for a user with an existing role value, then drops the role column', async () => {
  // Force migration 014 to be treated as "not yet applied" so runMigrations()
  // re-executes it against the just-restored pre-migration schema shape.
  await query(`DELETE FROM schema_migrations WHERE filename = '014_finalize_group_id.sql'`);

  const { rows } = await query(
    "INSERT INTO users (email, name, role) VALUES ($1, 'Backfill Test', 'checkin_helper') RETURNING id",
    [`backfill-${crypto.randomUUID()}@example.com`]
  );

  await runMigrations();

  const { rows: after } = await query(
    `SELECT groups.key FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [rows[0].id]
  );
  assert.equal(after[0].key, 'sl');

  const { rows: roleColumnAfter } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`
  );
  assert.equal(roleColumnAfter.length, 0);
});

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

test.after(async () => {
  await closePool();
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/integration/seedGroups.test.js`
Expected: all PASS.

- [ ] **Step 5: Verify the migration is safe on this project's own already-migrated dev database**

Using a real Postgres connection (bring up this worktree's own docker-compose stack, or reuse one already running for this worktree — check `docker ps` first, don't touch a different project's stack), run `npm run migrate` against the worktree's own dev database (which has already run `seedGroups()`'s old backfill+DDL logic in earlier sessions, so `users.role` should already be absent there) and confirm it completes without error — this proves migration 014's conditional `DO $$` block correctly no-ops when `role` doesn't exist. Then run `npm run seed-groups` and confirm it still completes without error and the app's groups remain unchanged (`docker compose exec db psql -U app -d pakyrion -c "SELECT key, is_protected FROM groups ORDER BY key;"` should show the same 8 groups as before).

- [ ] **Step 6: Run the FULL test suite**

Run: `npm test`
Expected: every test in the project passes. This is the mandatory full-suite check per this plan's Global Constraints — do not skip or substitute a scoped subset. If anything fails, fix it before considering this plan done.

- [ ] **Step 7: Final commit if Step 6 required fixes**

If Step 6 was already green with no changes needed, skip this step. Otherwise:

```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

- [ ] **Step 8: Commit**

```bash
git add db/migrations/014_finalize_group_id.sql db/seedGroups.js tests/integration/seedGroups.test.js
git commit -m "feat: move groups role-to-group_id finalization DDL into a real migration"
```

## Self-Review Notes (for the plan author / controller, not a task)

- Spec coverage: covers Abschnitt 5 ("Technische Schulden") of `2026-08-28-charakterklassen-und-hardening-design.md` in full — both named debts (leaked-HTTP-server test hygiene, groups DDL in a seed script).
- The plan's own audit (done fresh, not from stale memory) found the actual current state more nuanced than earlier session notes assumed: several files previously believed "already fully correct" (`accounts.test.js`) turned out to be partially mixed (some tests correctly guarded from an earlier plan's rate-limiting work, older tests still bare), and several files previously believed "fully broken" now have SOME guarded tests mixed in too (the 4 auth-adjacent files touched by the rate-limiting plan). Task 5 is written to handle this mixed reality explicitly rather than assuming a clean binary split.
- A real, non-obvious consequence of moving the DDL into a migration was caught during planning: `tests/integration/seedGroups.test.js` has a dedicated test that specifically exercises the OLD `seedGroups()`-does-the-backfill behavior — this test necessarily needs rewriting (not just left alone) to exercise `runMigrations()` instead, using the "delete this migration's own tracking row, then re-run" idiom to make an already-applied migration re-testable. This is folded into Task 6 rather than treated as a separate follow-up, since leaving the old test in place would make it fail outright once `seedGroups()` stops doing the backfill.
- Type/shape consistency: `withTestServer(fn)`'s signature (`async (port) => {...}`, returns whatever `fn` returns) is used identically across every task that consumes it (Tasks 2-5).
- Migration 014's 8-row INSERT must match `db/groupDefaults.js`'s `GROUP_DEFAULTS` exactly (same visible_menus/account_fields/etc. per group) — this is the same one-time data-duplication tradeoff this codebase's own final reviews have already accepted for prior migrations in this same table.
