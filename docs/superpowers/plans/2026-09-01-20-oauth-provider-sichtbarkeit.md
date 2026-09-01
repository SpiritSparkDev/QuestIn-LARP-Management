# OAuth-Provider-Sichtbarkeit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide OAuth login buttons (Google/Facebook/Discord) on the login page when their provider isn't actually configured, instead of always showing all three regardless of whether they'd work.

**Architecture:** One new public (unauthenticated) route reports which providers have both a client ID and secret configured; the login page fetches it once on load and hides the corresponding buttons.

**Tech Stack:** Same as the rest of this app — Node.js stdlib backend, vanilla JS frontend, no build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-qrcode-qol-design.md` (Plan 1)

## Global Constraints

- No frontend framework, no build step, no new npm dependencies.
- The LAST task must run the full `npm test` suite as an explicit step.
- The new route must NEVER leak the actual client id/secret values — only booleans.
- No `requireAuth` on the new route — the login page itself is unauthenticated by definition, so this must be reachable before any session exists.

---

### Task 1: Backend — provider-availability route

**Files:**
- Modify: `backend/auth/oauth.js`
- Create: `tests/integration/oauthProviders.test.js`

**Interfaces:**
- Produces: `GET /auth/oauth/providers` — public, no auth required. Returns `200 {"google": boolean, "facebook": boolean, "discord": boolean}` (keys match `PROVIDERS`' own keys from `backend/auth/oauthProviders.js`, so this stays correct automatically if a provider is ever added or removed there).

- [ ] **Step 1: Add the route**

Read the current file first (179 lines, already imports `PROVIDERS` from `./oauthProviders.js`). Add this route anywhere among the other `router.get('/auth/oauth/...')` routes (e.g. right before the `/auth/oauth/:provider/start` route, so the more-specific static path `/auth/oauth/providers` is registered — check `backend/router.js`'s matching logic first: if it matches static segments before named params like `:provider`, order won't matter; if it's first-match-wins in registration order, this route MUST be registered before the `:provider` catch-all or `/auth/oauth/providers` would incorrectly match `params.provider === 'providers'`. Read `backend/router.js` to confirm before deciding where to place it — if registration order matters, place this new route ABOVE the existing `router.get('/auth/oauth/:provider/start', ...)` line):

```javascript
router.get('/auth/oauth/providers', async () => {
  const available = {};
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    available[key] = Boolean(provider.clientId() && provider.clientSecret());
  }
  return { status: 200, body: available };
});
```

- [ ] **Step 2: Write the test**

Create `tests/integration/oauthProviders.test.js`. Read `tests/integration/oauth.test.js`'s current top-of-file setup first (env vars, `runMigrations()`, `seedGroups()`, `withTestServer` import — this project's OAuth test file already sets `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars for its own purposes; match that exact setup) and mirror it precisely:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
delete process.env.FACEBOOK_CLIENT_ID;
delete process.env.FACEBOOK_CLIENT_SECRET;
delete process.env.DISCORD_CLIENT_ID;
delete process.env.DISCORD_CLIENT_SECRET;
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { closePool } = await import('../../backend/db.js');

test('GET /auth/oauth/providers reports which providers are configured, without leaking secrets', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/oauth/providers`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.google, true);
    assert.equal(body.facebook, false);
    assert.equal(body.discord, false);
    assert.ok(!JSON.stringify(body).includes('test-google-client-id'));
    assert.ok(!JSON.stringify(body).includes('test-google-client-secret'));
  });
});

test('GET /auth/oauth/providers requires no authentication', async () => {
  await withTestServer(async (port) => {
    // No Cookie header at all — must still succeed, since the login page
    // itself calls this before any session exists.
    const res = await fetch(`http://localhost:${port}/auth/oauth/providers`);
    assert.equal(res.status, 200);
  });
});

test.after(async () => {
  await closePool();
});
```

(Read the actual current file's import style before finalizing — if `tests/integration/oauth.test.js` imports `createServer` directly rather than `withTestServer` for some of its tests, prefer `withTestServer` here anyway since it's the established best-practice pattern for every NEW test file in this project, per the Technische-Schulden initiative.)

- [ ] **Step 3: Run the tests**

Run: `node --test tests/integration/oauthProviders.test.js --test-concurrency=1`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/auth/oauth.js tests/integration/oauthProviders.test.js
git commit -m "feat: add GET /auth/oauth/providers reporting which OAuth providers are configured"
```

---

### Task 2: Frontend — hide unconfigured provider buttons

**Files:**
- Modify: `frontend/login.html`

**Interfaces:**
- Consumes: `GET /auth/oauth/providers` from Task 1.

- [ ] **Step 1: Tag each OAuth link with its provider key**

Read the current file first (81 lines). Change:
```html
    <div class="divider-word">oder anmelden mit</div>
    <div class="oauth-row">
      <a href="/auth/oauth/google/start">Google</a>
      <a href="/auth/oauth/facebook/start">Facebook</a>
      <a href="/auth/oauth/discord/start">Discord</a>
    </div>
```
to:
```html
    <div class="divider-word" id="oauth-divider">oder anmelden mit</div>
    <div class="oauth-row" id="oauth-row">
      <a href="/auth/oauth/google/start" data-provider="google">Google</a>
      <a href="/auth/oauth/facebook/start" data-provider="facebook">Facebook</a>
      <a href="/auth/oauth/discord/start" data-provider="discord">Discord</a>
    </div>
```

- [ ] **Step 2: Fetch availability and hide unconfigured buttons**

In the `<script type="module">` block, add this anywhere after the existing `const message = document.getElementById('message');` line (e.g. right after it, before the `oauth_error` check):

```javascript
try {
  const res = await fetch('/auth/oauth/providers');
  if (res.ok) {
    const available = await res.json();
    const links = document.querySelectorAll('[data-provider]');
    links.forEach((link) => {
      if (!available[link.dataset.provider]) link.style.display = 'none';
    });
    if (!Object.values(available).some(Boolean)) {
      document.getElementById('oauth-divider').style.display = 'none';
      document.getElementById('oauth-row').style.display = 'none';
    }
  }
} catch {
  // Network hiccup fetching availability — leave every button visible;
  // worst case a misconfigured provider shows its existing 503 error on click.
}
```

- [ ] **Step 3: Manual verification**

Start the dev server, use the Browser tool: navigate to `/login.html`. Check this worktree's `.env` for which `*_CLIENT_ID`/`*_CLIENT_SECRET` pairs are actually set — confirm only the configured providers' buttons show, and any unconfigured ones are hidden. If practical, temporarily unset all three provider env vars and restart the app container to confirm the whole "oder anmelden mit" section disappears when zero providers are configured, then restore the original `.env` and restart again. Screenshot both states as evidence.

- [ ] **Step 4: Commit**

```bash
git add frontend/login.html
git commit -m "feat: hide OAuth login buttons for unconfigured providers"
```

---

### Task 3: Full test suite

**Files:** None (verification-only task).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test in the project passes. Mandatory final gate.

- [ ] **Step 2: Commit if Step 1 required fixes**

If Step 1 was already green, skip this step. Otherwise:
```bash
git add -A
git commit -m "fix: address full test suite failures found in final verification"
```

## Self-Review Notes

- Spec coverage: covers Plan 1 of `2026-09-01-qrcode-qol-design.md` in full.
- Route-ordering risk called out explicitly in Task 1 Step 1 rather than assumed — `backend/router.js`'s actual matching semantics must be checked before deciding where `/auth/oauth/providers` needs to sit relative to `/auth/oauth/:provider/start`, since a static path being shadowed by an earlier-registered param route is a realistic mistake for this specific route name.
- Type/interface consistency: the response shape's keys are derived from `PROVIDERS`'s own keys (`Object.entries(PROVIDERS)`), not hardcoded — stays correct if a provider is added/removed later without this route needing a matching edit.
