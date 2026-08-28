# Rate-Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add rate limiting to the auth endpoints that today have none at all, so this app can go live without an obvious brute-force/credential-stuffing/mail-bombing hole.

**Architecture:** A single in-memory fixed-window limiter (`backend/middleware/rateLimit.js`), composed the same way every other middleware in this app already is (`requireAuth`/`requireMenu` style — `(options) => (handler) => async (ctx) => {...}`). Every covered endpoint gets an IP-keyed limit via the middleware wrapper; `POST /auth/login` additionally gets a per-email limit checked inline inside the handler (after the request body is already parsed, since the body stream can only be read once and the middleware runs before the handler reads it).

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-28-charakterklassen-und-hardening-design.md` (Abschnitt 4 "Rate-Limiting")

## Global Constraints

- No frontend framework, no build step, no new npm dependencies — the limiter is pure Node stdlib (`Map`, `Date.now()`), no Redis, no rate-limit library.
- Exactly one process/instance runs this app (confirmed by the existing `docker-compose.yml` — a single `app` service) — an in-memory limiter is correct for this deployment; it does NOT need to survive a restart or be shared across instances.
- Covered endpoints, per the spec: `POST /auth/register`, `POST /auth/login`, `POST /auth/password-reset/request`, `POST /auth/password-reset/confirm`, `GET /auth/oauth/:provider/start`. `GET /auth/oauth/:provider/callback` and `POST /auth/verify/resend` are explicitly NOT in the spec's list — do not add limiting to them in this plan.
- Limits: 10 attempts per 15 minutes per IP on every covered endpoint; `POST /auth/login` additionally gets 5 attempts per 15 minutes per email address (the two limits are independent — either one tripping returns 429).
- A rate-limited request returns `429` with `{ error: 'too many requests, please try again later' }` (or, for the login per-email case, a message that doesn't reveal whether the email exists — keep it generic, matching how login's existing `401`/`403` responses already avoid leaking account state beyond "wrong credentials"/"not verified").
- Every existing test must still pass; verify with each task's specified scope before the final full-suite gate.

---

### Task 1: Rate-limit middleware core

**Files:**
- Create: `backend/middleware/rateLimit.js`
- Create: `tests/unit/rateLimit.test.js`

**Interfaces:**
- Produces: `export function isRateLimited(key, maxAttempts, windowMs, now = Date.now())` — returns `true` if the key has already hit `maxAttempts` within the current `windowMs` window (and does NOT increment further), `false` otherwise (and increments the count, starting a new window if the previous one expired). The `now` parameter exists purely for deterministic unit testing — production call sites never pass it.
- Produces: `export function rateLimit({ keyPrefix, maxAttempts, windowMs })` — a composable middleware, same shape as `requireMenu`/`requireAdminGroup` in `backend/middleware/authorize.js`: returns `(handler) => async (ctx) => {...}`. Keys on `` `${keyPrefix}:${ip}` `` where `ip` comes from `ctx.req.socket.remoteAddress`. Consumed by Task 2 (register, password-reset, oauth-start) and Task 3 (login's IP dimension).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/rateLimit.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, rateLimit } from '../../backend/middleware/rateLimit.js';

test('isRateLimited allows the first maxAttempts calls for a key, then blocks', () => {
  const key = 'test-key-1';
  for (let i = 0; i < 5; i++) {
    assert.equal(isRateLimited(key, 5, 60_000, 1000), false, `attempt ${i + 1} should be allowed`);
  }
  assert.equal(isRateLimited(key, 5, 60_000, 1000), true, 'the 6th attempt should be blocked');
});

test('isRateLimited resets the count after the window elapses', () => {
  const key = 'test-key-2';
  for (let i = 0; i < 3; i++) {
    isRateLimited(key, 3, 1000, 1000);
  }
  assert.equal(isRateLimited(key, 3, 1000, 1500), true, 'still within the window, should be blocked');
  assert.equal(isRateLimited(key, 3, 1000, 2500), false, 'window has elapsed, should be allowed again');
});

test('isRateLimited tracks different keys independently', () => {
  for (let i = 0; i < 5; i++) {
    isRateLimited('test-key-3a', 5, 60_000, 1000);
  }
  assert.equal(isRateLimited('test-key-3a', 5, 60_000, 1000), true, 'key-3a should be blocked');
  assert.equal(isRateLimited('test-key-3b', 5, 60_000, 1000), false, 'a different key should not be affected');
});

test('rateLimit middleware calls the handler when under the limit, and returns 429 when over it', async () => {
  const handler = async () => ({ status: 200, body: { ok: true } });
  const wrapped = rateLimit({ keyPrefix: `test-mw-${Date.now()}`, maxAttempts: 2, windowMs: 60_000 })(handler);
  const ctx = { req: { socket: { remoteAddress: '127.0.0.1' } } };

  const first = await wrapped(ctx);
  assert.equal(first.status, 200);
  const second = await wrapped(ctx);
  assert.equal(second.status, 200);
  const third = await wrapped(ctx);
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'too many requests, please try again later');
});

test('rateLimit middleware tracks different IPs independently', async () => {
  const handler = async () => ({ status: 200, body: { ok: true } });
  const prefix = `test-mw-ip-${Date.now()}`;
  const wrapped = rateLimit({ keyPrefix: prefix, maxAttempts: 1, windowMs: 60_000 })(handler);

  const first = await wrapped({ req: { socket: { remoteAddress: '10.0.0.1' } } });
  assert.equal(first.status, 200);
  const second = await wrapped({ req: { socket: { remoteAddress: '10.0.0.1' } } });
  assert.equal(second.status, 429);
  const third = await wrapped({ req: { socket: { remoteAddress: '10.0.0.2' } } });
  assert.equal(third.status, 200, 'a different IP should have its own limit');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/rateLimit.test.js`
Expected: FAIL — `Cannot find module '../../backend/middleware/rateLimit.js'` or similar (module doesn't exist yet).

- [ ] **Step 3: Implement `backend/middleware/rateLimit.js`**

```javascript
const buckets = new Map();

// In-memory, single-instance limiter — correct for this app's deployment
// (one `app` service in docker-compose.yml, no shared/multi-instance
// state needed). Buckets for keys that stop being used are never evicted;
// at this app's scale (a LARP registration tool, not a public high-traffic
// service) that's an acceptable tradeoff, not a real memory leak risk.
export function isRateLimited(key, maxAttempts, windowMs, now = Date.now()) {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  if (bucket.count >= maxAttempts) {
    return true;
  }
  bucket.count += 1;
  return false;
}

export function rateLimit({ keyPrefix, maxAttempts, windowMs }) {
  return (handler) => async (ctx) => {
    const ip = ctx.req.socket.remoteAddress || 'unknown';
    if (isRateLimited(`${keyPrefix}:${ip}`, maxAttempts, windowMs)) {
      return { status: 429, body: { error: 'too many requests, please try again later' } };
    }
    return handler(ctx);
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/rateLimit.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/middleware/rateLimit.js tests/unit/rateLimit.test.js
git commit -m "feat: add an in-memory fixed-window rate limiter middleware"
```

---

### Task 2: Rate-limit register, password-reset, and OAuth-start

**Files:**
- Modify: `backend/auth/register.js`
- Modify: `backend/auth/passwordReset.js`
- Modify: `backend/auth/oauth.js`
- Modify: `tests/integration/auth-register.test.js`
- Modify: `tests/integration/auth-password-reset.test.js`
- Modify: `tests/integration/oauth.test.js`

**Interfaces:**
- Consumes: `rateLimit({ keyPrefix, maxAttempts, windowMs })` from Task 1.

- [ ] **Step 1: Wrap `POST /auth/register` in `backend/auth/register.js`**

Add the import and wrap the handler. Change:

```javascript
import crypto from 'node:crypto';
import { router } from '../routes.js';
import { query } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { sendVerificationEmail } from './mailer.js';
import { readJsonBody } from '../httpBody.js';
import { logger } from '../logger.js';
```

to:

```javascript
import crypto from 'node:crypto';
import { router } from '../routes.js';
import { query } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { sendVerificationEmail } from './mailer.js';
import { readJsonBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rateLimit.js';

const REGISTER_RATE_LIMIT = { keyPrefix: 'register', maxAttempts: 10, windowMs: 15 * 60 * 1000 };
```

Change the `router.post('/auth/register', async ({ req, requestId }) => {` line to:

```javascript
router.post('/auth/register', rateLimit(REGISTER_RATE_LIMIT)(async ({ req, requestId }) => {
```

and change the handler's closing `});` (at the very end of that specific handler, right before the blank line preceding `router.post('/auth/verify/resend', ...)`) to `}));` — the extra closing paren matches the added `rateLimit(...)(` wrapper. Only this ONE handler (`/auth/register`) changes; `/auth/verify/resend` and `GET /auth/verify` are untouched per this plan's Global Constraints.

- [ ] **Step 2: Wrap both password-reset routes in `backend/auth/passwordReset.js`**

Replace the entire file:

```javascript
import crypto from 'node:crypto';
import { router } from '../routes.js';
import { query } from '../db.js';
import { hashPassword } from '../crypto/password.js';
import { sendPasswordResetEmail } from './mailer.js';
import { readJsonBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rateLimit.js';

const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_RATE_LIMIT = { keyPrefix: 'password-reset', maxAttempts: 10, windowMs: 15 * 60 * 1000 };

router.post('/auth/password-reset/request', rateLimit(RESET_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const email = body.email?.toLowerCase();
  if (!email) return { status: 400, body: { error: 'email is required' } };

  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows.length > 0) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await query(
      'INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, rows[0].id, expiresAt]
    );
    try {
      await sendPasswordResetEmail(email, token);
    } catch (err) {
      logger.error('failed to send password reset email', { error: err.message });
    }
  }

  // Always 200 regardless of whether the email is registered — avoids leaking which emails exist.
  return { status: 200, body: { requested: true } };
}));

router.post('/auth/password-reset/confirm', rateLimit(RESET_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { token, password } = body;
  if (!token || !password) {
    return { status: 400, body: { error: 'token and password are required' } };
  }
  if (password.length < 8) {
    return { status: 400, body: { error: 'password must be at least 8 characters' } };
  }

  const { rows } = await query(
    'SELECT user_id, expires_at FROM password_reset_tokens WHERE token = $1',
    [token]
  );
  if (rows.length === 0 || new Date(rows[0].expires_at) < new Date()) {
    return { status: 400, body: { error: 'invalid or expired token' } };
  }

  const passwordHash = await hashPassword(password);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, rows[0].user_id]);
  await query('DELETE FROM password_reset_tokens WHERE user_id = $1', [rows[0].user_id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [rows[0].user_id]);
  return { status: 200, body: { reset: true } };
}));
```

(Both routes share the same `RESET_RATE_LIMIT` constant but get INDEPENDENT buckets — `rateLimit`'s `keyPrefix` is combined with the caller's IP into one bucket key per middleware INSTANCE, and each `rateLimit(RESET_RATE_LIMIT)` call here creates its own closure over `isRateLimited`, so `request` and `confirm` don't share attempt counts even though they share a `keyPrefix` string constant — wait, this is not quite right: re-read Task 1's `rateLimit` implementation — the bucket key is `` `${keyPrefix}:${ip}` ``, so if BOTH routes use the identical string `'password-reset'` as `keyPrefix`, they WILL share the same bucket per IP. This is intentional here: 10 combined attempts per 15 minutes per IP across BOTH password-reset endpoints together, treating them as one feature for rate-limiting purposes. This is a deliberate design choice, not a bug — call it out in the commit if it needs clarifying later.)

- [ ] **Step 3: Wrap `GET /auth/oauth/:provider/start` in `backend/auth/oauth.js`**

Add the import near the top of the file (after the existing imports):

```javascript
import { rateLimit } from '../middleware/rateLimit.js';

const OAUTH_START_RATE_LIMIT = { keyPrefix: 'oauth-start', maxAttempts: 10, windowMs: 15 * 60 * 1000 };
```

Change the `router.get('/auth/oauth/:provider/start', async ({ params }) => {` line to:

```javascript
router.get('/auth/oauth/:provider/start', rateLimit(OAUTH_START_RATE_LIMIT)(async ({ req, params }) => {
```

(Note: the handler signature gains `req` — it wasn't destructured before since the original handler only used `params`, but `rateLimit`'s wrapper needs `ctx.req` to exist, which it always does since every route handler receives the full `ctx` object; you don't need to reference `req` inside the handler body, just keep it available in case — actually simplest is to leave the destructuring as `{ params }` since `ctx.req` is still present on the full context object passed to the WRAPPER, not the inner handler's destructured parameters; the wrapper reads `ctx.req` directly before calling `handler(ctx)`. Keep the inner handler's destructuring exactly as `{ params }`, unchanged.)

Change the closing `});` of this ONE route handler (immediately before the blank line preceding `router.get('/auth/oauth/:provider/callback', ...)`) to `}));`. The callback route is completely untouched.

- [ ] **Step 4: Write the failing integration tests**

Add to `tests/integration/auth-register.test.js` (read the current file first to match its exact helper/setup conventions, then append):

```javascript
test('POST /auth/register is rate-limited per IP after 10 attempts in the window', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastStatus;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`http://localhost:${port}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `ratelimit-${i}-${crypto.randomUUID()}@example.com`, password: 'correct horse battery staple', name: 'Rate Limit Test' }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  } finally {
    server.close();
  }
});
```

Add to `tests/integration/auth-password-reset.test.js` (append, matching its existing conventions):

```javascript
test('POST /auth/password-reset/request is rate-limited per IP after 10 attempts in the window', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastStatus;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`http://localhost:${port}/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  } finally {
    server.close();
  }
});
```

Add to `tests/integration/oauth.test.js` (append, matching its existing conventions):

```javascript
test('GET /auth/oauth/:provider/start is rate-limited per IP after 10 attempts in the window', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastStatus;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`http://localhost:${port}/auth/oauth/google/start`, { redirect: 'manual' });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  } finally {
    server.close();
  }
});
```

(This test only works meaningfully if the `google` provider isn't configured in the test environment, which would make every one of the 11 attempts return 503 instead of 302 BEFORE the 11th — that's fine, the rate limiter still runs before the provider-configuration check inside the handler, so the 11th request is 429 regardless of what the first 10 would have returned. Confirm this by reading `backend/auth/oauth.js`'s handler order: the `rateLimit` wrapper runs first, unconditionally, before the handler's own `if (!provider.clientId() ...)` check.)

- [ ] **Step 5: Run the tests to verify they fail, then pass**

Run: `node --test tests/integration/auth-register.test.js tests/integration/auth-password-reset.test.js tests/integration/oauth.test.js`
Expected: FAIL before Steps 1-3's code changes (429 never happens, `lastStatus` would be 201/400/200/302/503 depending on the endpoint), PASS after.

- [ ] **Step 6: Commit**

```bash
git add backend/auth/register.js backend/auth/passwordReset.js backend/auth/oauth.js tests/integration/auth-register.test.js tests/integration/auth-password-reset.test.js tests/integration/oauth.test.js
git commit -m "feat: rate-limit register, password-reset, and oauth-start endpoints per IP"
```

---

### Task 3: Rate-limit login (per IP AND per email); full test suite

**Files:**
- Modify: `backend/auth/login.js`
- Modify: `tests/integration/auth-login.test.js`

**Interfaces:**
- Consumes: `rateLimit` (IP dimension) and `isRateLimited` (email dimension, called directly since the email only becomes available after `readJsonBody` has already parsed the request body) from Task 1.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/auth-login.test.js` (read the current file first to match its exact `registerAndVerify`/setup conventions, then append):

```javascript
test('POST /auth/login is rate-limited per IP after 10 attempts in the window, even across different emails', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    let lastStatus;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`http://localhost:${port}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `nobody-${i}@example.com`, password: 'wrong password' }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  } finally {
    server.close();
  }
});

test('POST /auth/login is rate-limited per email after 5 attempts in the window, even from conceptually different requests', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const email = `ratelimit-email-${crypto.randomUUID()}@example.com`;
    let lastStatus;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`http://localhost:${port}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong password' }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  } finally {
    server.close();
  }
});
```

(Both tests use fresh, never-registered emails/servers so they don't interact with each other's or other tests' rate-limit buckets — each `createServer().listen(0)` call is a fresh HTTP server, but the rate limiter's `buckets` Map is MODULE-level state that persists across server instances within the same test process/file. The first test uses 11 DIFFERENT emails from the SAME IP (`127.0.0.1`, since all `fetch` calls in this test file originate from the test process itself) to isolate the IP dimension; the second test uses ONE email across 6 calls to isolate the email dimension. Since the IP limit is 10 and the email limit is 5, and the second test's IP-bucket contribution is only 6 requests, it won't accidentally trip the IP limit from the first test's already-consumed 11 IP-bucket attempts if they run in the same file/process — but if you see cross-test interference given the shared module state, that's expected given a real fixed 15-minute window and NOT a bug to fix; note it in your report rather than trying to reset the limiter between tests, since production code has no test-only reset hook and shouldn't grow one just for this.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/integration/auth-login.test.js`
Expected: FAIL — both new tests never see a 429 (no rate limiting exists yet).

- [ ] **Step 3: Wrap `POST /auth/login` in `backend/auth/login.js`**

Replace the entire file:

```javascript
import { router } from '../routes.js';
import { query } from '../db.js';
import { verifyPassword } from '../crypto/password.js';
import { createSession, destroySession } from './sessions.js';
import { readJsonBody } from '../httpBody.js';
import { parseCookies, serializeSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME } from './cookies.js';
import { rateLimit, isRateLimited } from '../middleware/rateLimit.js';

const LOGIN_IP_RATE_LIMIT = { keyPrefix: 'login-ip', maxAttempts: 10, windowMs: 15 * 60 * 1000 };
const LOGIN_EMAIL_MAX_ATTEMPTS = 5;
const LOGIN_EMAIL_WINDOW_MS = 15 * 60 * 1000;

router.post('/auth/login', rateLimit(LOGIN_IP_RATE_LIMIT)(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };

  const { password } = body;
  const email = body.email?.toLowerCase();
  if (!email || !password) {
    return { status: 400, body: { error: 'email and password are required' } };
  }

  if (isRateLimited(`login-email:${email}`, LOGIN_EMAIL_MAX_ATTEMPTS, LOGIN_EMAIL_WINDOW_MS)) {
    return { status: 429, body: { error: 'too many login attempts, please try again later' } };
  }

  const { rows } = await query(
    'SELECT id, password_hash, email_verified FROM users WHERE email = $1',
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
  if (!user.email_verified) {
    return { status: 403, body: { error: 'email not verified' } };
  }

  const session = await createSession(user.id);
  return {
    status: 200,
    body: { id: user.id },
    headers: { 'Set-Cookie': serializeSessionCookie(session.token, session.expiresAt) },
  };
}));

router.post('/auth/logout', async ({ req }) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) await destroySession(token);

  return {
    status: 200,
    body: { loggedOut: true },
    headers: { 'Set-Cookie': clearSessionCookie() },
  };
});
```

(`/auth/logout` is untouched — no rate limiting needed there, it's not named in the spec and isn't a credential-guessing surface. The per-email check happens AFTER the `email`/`password` presence validation but BEFORE the database lookup, so a malformed request — missing email — never counts against the per-email bucket, only well-formed login attempts do.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/integration/auth-login.test.js`
Expected: all PASS (existing + new).

- [ ] **Step 5: Verify visually**

Using Claude Browser tools against the running dev stack: go to `/login.html`, attempt to log in with a wrong password 5 times in a row for the same (real or fake) email, confirm the 6th attempt shows a rate-limit error message instead of the normal "invalid credentials" message. Restart the app container afterward (`docker compose restart app`) to clear the in-memory rate-limit state before continuing to use the dev stack normally.

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
git add backend/auth/login.js tests/integration/auth-login.test.js
git commit -m "feat: rate-limit login per IP and per email"
```

## Self-Review Notes (for the plan author / controller, not a task)

- Spec coverage: covers Abschnitt 4 ("Rate-Limiting") of `2026-08-28-charakterklassen-und-hardening-design.md` in full — in-memory fixed-window limiter, no new deps, per-IP on register/login/password-reset/oauth-start, additionally per-email on login. Exact numeric limits (10/15min per IP, 5/15min per email) are this plan's own concrete choice, since the spec explicitly deferred them as an implementation detail.
- `/auth/verify/resend` is structurally identical to `/auth/password-reset/request` (email-triggered, no visible failure state, mail-bombing risk) but is NOT in the spec's named endpoint list — deliberately left out of this plan's scope rather than silently expanded. Worth flagging to the user as a possible follow-up, not something to add unasked.
- Type/shape consistency: `rateLimit({ keyPrefix, maxAttempts, windowMs })`'s option-object shape and `isRateLimited(key, maxAttempts, windowMs, now)`'s positional signature are used identically across Tasks 2 and 3 — no drift.
- The password-reset request/confirm endpoints deliberately share ONE rate-limit bucket per IP (same `keyPrefix` string) rather than independent buckets — a design choice noted explicitly in Task 2 Step 2, not an oversight.
- Unbounded `Map` growth (one bucket per unique key ever seen, never evicted) is a known, accepted tradeoff at this app's scale — documented as a code comment in Task 1 rather than silently ignored or over-engineered with a cleanup mechanism the spec never asked for.
