import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

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

after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'offline-perm-%'");
  await query("DELETE FROM groups WHERE key LIKE 'offline_perm_%'");
  await closePool();
});

async function makeSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Off', 'Line', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`offline-perm-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return `session=${(await createSession(rows[0].id)).token}`;
}

test('only roles with the offline permission may use the offline endpoints and see the switch', async () => {
  const key = `offline_perm_${crypto.randomUUID().slice(0, 8)}`;
  await query("INSERT INTO groups (key, name, visible_menus, account_fields) VALUES ($1, $1, '[]', '[]')", [key]);
  await withTestServer(async (port) => {
    const get = (cookie, path) => fetch(`http://localhost:${port}${path}`, { headers: { Cookie: cookie } });
    const member = await makeSession('mitglied');
    const custom = await makeSession(key);
    const admin = await makeSession('admin');

    assert.equal((await get(member, '/offline/status')).status, 403);
    assert.equal((await get(custom, '/offline/status')).status, 403);
    assert.equal((await get(admin, '/offline/status')).status, 200);
    assert.equal((await (await get(admin, '/account')).json()).canUseOffline, true);
    assert.equal((await (await get(member, '/account')).json()).canUseOffline, false);

    await query('UPDATE groups SET can_use_offline = true WHERE key = $1', [key]);
    assert.equal((await get(custom, '/offline/status')).status, 200);
    assert.equal((await (await get(custom, '/account')).json()).canUseOffline, true);
  });
});
