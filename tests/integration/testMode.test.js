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

after(async () => {
  const { removeTestData } = await import('../../backend/testMode/load.js');
  await removeTestData();
  await query('UPDATE app_settings SET tavern_enabled = false');
  await closePool();
});

async function makeUserAndSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Test', 'Modus', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`testmode-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('test mode loads 75 fictional people with characters, groups and an event, and removes them again', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUserAndSession('admin');
    const member = await makeUserAndSession('mitglied');
    const headers = { 'Content-Type': 'application/json', Cookie: admin.cookie };

    const { removeTestData } = await import('../../backend/testMode/load.js');
    await removeTestData();

    assert.equal((await fetch(`${base}/test-mode`, { headers: { Cookie: member.cookie } })).status, 403);
    assert.equal((await (await fetch(`${base}/test-mode`, { headers })).json()).enabled, false);
    assert.equal((await (await fetch(`${base}/account`, { headers })).json()).testMode, false);

    // With the tavern add-on on, test people also get accounts, top-ups and charges.
    await fetch(`${base}/app-settings`, { method: 'PUT', headers, body: JSON.stringify({ tavernEnabled: true }) });
    const loaded = await fetch(`${base}/test-mode`, { method: 'POST', headers });
    assert.equal(loaded.status, 201);
    const summary = await loaded.json();
    assert.equal(summary.people, 75);
    assert.equal(summary.events, 1);
    assert.ok(summary.characters >= 75);
    assert.equal(summary.menuItems, 16);
    const { rows: tavern } = await query("SELECT COUNT(*) FILTER (WHERE t.type = 'topup')::int AS topups, COUNT(*) FILTER (WHERE t.type = 'charge')::int AS charges FROM tavern_transactions t JOIN tavern_accounts a ON a.id = t.account_id JOIN events e ON e.id = a.event_id WHERE e.is_test");
    assert.ok(tavern[0].topups > 20);
    assert.ok(tavern[0].charges > 20);

    assert.equal((await fetch(`${base}/test-mode`, { method: 'POST', headers })).status, 409);
    assert.equal((await (await fetch(`${base}/account`, { headers })).json()).testMode, true);

    const { rows: regs } = await query("SELECT COUNT(*)::int AS n FROM registrations r JOIN users u ON u.id = r.user_id WHERE u.is_test");
    assert.equal(regs[0].n, 75);
    const { rows: groups } = await query(
      "SELECT managed_by_user_id AS owner, COUNT(*)::int AS n FROM users WHERE is_test AND managed_by_user_id IS NOT NULL GROUP BY managed_by_user_id ORDER BY n DESC"
    );
    assert.equal(groups.length, 6);
    assert.deepEqual(groups.map((g) => g.n), [5, 4, 4, 3, 3, 2]);
    const { rows: noPassword } = await query("SELECT COUNT(*)::int AS n FROM users WHERE is_test AND password_hash IS NOT NULL");
    assert.equal(noPassword[0].n, 0);

    // Real data is never touched by removal.
    const removed = await fetch(`${base}/test-mode`, { method: 'DELETE', headers });
    assert.equal(removed.status, 200);
    const status = await removed.json();
    assert.equal(status.enabled, false);
    assert.equal(status.people, 0);
    assert.equal(status.events, 0);
    const { rows: stillThere } = await query('SELECT 1 FROM users WHERE id = $1', [admin.userId]);
    assert.equal(stillThere.length, 1);
    const { rows: menuLeft } = await query('SELECT COUNT(*)::int AS n FROM tavern_items WHERE is_test');
    assert.equal(menuLeft[0].n, 0);
    const { rows: leftover } = await query("SELECT COUNT(*)::int AS n FROM registrations r JOIN events e ON e.id = r.event_id WHERE e.name LIKE 'Testcon:%'");
    assert.equal(leftover[0].n, 0);
  });
});
