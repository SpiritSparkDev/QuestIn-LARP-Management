import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { requireAuth } = await import('../../backend/middleware/authenticate.js');
const { requireMenu } = await import('../../backend/middleware/authorize.js');

async function makeUser(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id) VALUES ($1, 'Mid', 'Test', (SELECT id FROM groups WHERE key = $2)) RETURNING id",
    [`mid-${Date.now()}-${Math.random()}@example.com`, groupKey]
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

test('requireAuth attaches the user (with group) and calls the handler for a valid session', async () => {
  const userId = await makeUser();
  const session = await createSession(userId);
  const handler = requireAuth(async ({ user }) => ({ status: 200, body: { userId: user.id, groupKey: user.group.key } }));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 200);
  assert.equal(result.body.userId, userId);
  assert.equal(result.body.groupKey, 'sc');
});

test('requireMenu rejects a user whose group cannot see the menu', async () => {
  const userId = await makeUser('sc');
  const session = await createSession(userId);
  const handler = requireAuth(requireMenu('mitglieder')(async () => ({ status: 200, body: {} })));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 403);
});

test('requireMenu allows a user whose group can see the menu', async () => {
  const userId = await makeUser('admin');
  const session = await createSession(userId);
  const handler = requireAuth(requireMenu('checkin')(async () => ({ status: 200, body: { ok: true } })));
  const result = await handler({ req: { headers: { cookie: `session=${session.token}` } } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test.after(async () => {
  await closePool();
});
