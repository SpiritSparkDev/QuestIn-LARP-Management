import { test } from 'node:test';
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

async function makeUserAndSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'View', 'As', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`view-as-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('an admin can view the tool as another group, only an admin may, and it can always be ended', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const headers = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });
    const admin = await makeUserAndSession('admin');
    const member = await makeUserAndSession('mitglied');
    const { rows } = await query("INSERT INTO groups (key, name, visible_menus, account_fields, can_override_checkin_status) VALUES ('view_as_staff', 'Nur Check-In', $1, $2, true) RETURNING id", [JSON.stringify(['checkin']), JSON.stringify(['conTage'])]);
    const groupId = rows[0].id;
    const account = async (cookie) => (await fetch(`${base}/account`, { headers: headers(cookie) })).json();
    const post = (cookie, body) => fetch(`${base}/view-as`, { method: 'POST', headers: headers(cookie), body: JSON.stringify(body) });

    assert.equal((await post(member.cookie, { groupId })).status, 403);
    assert.equal((await post(admin.cookie, { groupId: crypto.randomUUID() })).status, 404);
    assert.equal((await post(admin.cookie, { groupId: 'nope' })).status, 400);

    // Normal admin view first.
    assert.equal((await account(admin.cookie)).group.key, 'admin');
    assert.equal((await fetch(`${base}/groups`, { headers: headers(admin.cookie) })).status, 200);

    assert.equal((await post(admin.cookie, { groupId })).status, 200);
    const viewed = await account(admin.cookie);
    assert.equal(viewed.group.key, 'view_as_staff');
    assert.deepEqual(viewed.menus, ['checkin']);
    assert.equal(viewed.canOverrideCheckinStatus, true);
    assert.equal(viewed.viewingAs.name, 'Nur Check-In');
    // The server really applies that group: admin-only routes are closed now.
    assert.equal((await fetch(`${base}/groups`, { headers: headers(admin.cookie) })).status, 403);
    assert.equal((await fetch(`${base}/members`, { headers: headers(admin.cookie) })).status, 403);

    // Ending works from inside the viewed role.
    assert.equal((await post(admin.cookie, { groupId: null })).status, 200);
    assert.equal((await account(admin.cookie)).group.key, 'admin');
    assert.equal((await fetch(`${base}/groups`, { headers: headers(admin.cookie) })).status, 200);
    assert.equal((await account(admin.cookie)).viewingAs, undefined);
  });
});

test.after(async () => {
  await query("UPDATE sessions SET view_as_group_id = NULL");
  await query("DELETE FROM groups WHERE key = 'view_as_staff'");
  await query("DELETE FROM users WHERE email LIKE 'view-as-%'");
  await closePool();
});
