import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { requireAuth } = await import('../../backend/middleware/authenticate.js');
const { requireRole } = await import('../../backend/middleware/authorize.js');

async function makeUser(role = 'participant') {
  const { rows } = await query(
    "INSERT INTO users (email, name, role, email_verified) VALUES ($1, 'Mid Test', $2, true) RETURNING id",
    [`mid-${Date.now()}-${Math.random()}@example.com`, role]
  );
  return rows[0].id;
}

test('requireAuth rejects a request with no cookie', async () => {
  const handler = requireAuth(async () => ({ status: 200, body: {} }));
  const result = await handler({ req: { headers: {} } });
  assert.equal(result.status, 401);
});

test('requireAuth rejects an invalid session token', async () => {
  const handler = requireAuth(async () => ({ status: 200, body: {} }));
  const result = await handler({ req: { headers: { cookie: 'session=not-a-real-token' } } });
  assert.equal(result.status, 401);
});

test('requireAuth attaches the user and calls the handler for a valid session', async () => {
  const userId = await makeUser();
  const session = await createSession(userId);
  const handler = requireAuth(async ({ user }) => ({ status: 200, body: { userId: user.id } }));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 200);
  assert.equal(result.body.userId, userId);
});

test('requireRole rejects a user with the wrong role', async () => {
  const userId = await makeUser('participant');
  const session = await createSession(userId);
  const handler = requireAuth(requireRole('admin')(async () => ({ status: 200, body: {} })));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 403);
});

test('requireRole allows a user with a matching role', async () => {
  const userId = await makeUser('admin');
  const session = await createSession(userId);
  const handler = requireAuth(requireRole('admin', 'checkin_helper')(async () => ({ status: 200, body: { ok: true } })));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test.after(async () => {
  await closePool();
});
