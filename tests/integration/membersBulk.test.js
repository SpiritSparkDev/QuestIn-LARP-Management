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
  await query("UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'mitglied') WHERE group_id IN (SELECT id FROM groups WHERE key LIKE 'bulk\\_test\\_%')");
  await query("DELETE FROM groups WHERE key LIKE 'bulk\\_test\\_%'");
  await closePool();
});

async function makeUser(groupKey = 'mitglied') {
  const { rows } = await query(
    'INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, \'Bulk\', \'Test\', (SELECT id FROM groups WHERE key = $2), true) RETURNING id',
    [`bulk-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeGroup({ accountFields = [], override = false }) {
  const key = `bulk_test_${crypto.randomUUID().slice(0, 8)}`;
  await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status, can_export_members)
     VALUES ($1, $1, '["mitglieder"]', $2, false, $3, false)`,
    [key, JSON.stringify(accountFields), override]
  );
  return key;
}

const post = (port, cookie, path, body) => fetch(`http://localhost:${port}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
});

const lastAudit = async (actorId) => (await query(
  "SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'members.bulk' ORDER BY created_at DESC LIMIT 1", [actorId]
)).rows[0]?.details;

test('bulk group change: partial success, unknown id and own account reported per id, one audit entry', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const a = await makeUser();
    const b = await makeUser();
    const ghost = crypto.randomUUID();
    const res = await post(port, admin.cookie, '/members-bulk/group', { ids: [a.userId, b.userId, ghost, admin.userId, 'nope'], group: 'moderator' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, 2);
    assert.equal(body.failed, 3);
    assert.equal(body.results[a.userId].ok, true);
    assert.equal(body.results[ghost].ok, false);
    assert.equal(body.results[admin.userId].ok, false);
    assert.equal(body.results.nope.ok, false);
    const { rows } = await query('SELECT g.key FROM users u JOIN groups g ON g.id = u.group_id WHERE u.id = $1', [a.userId]);
    assert.equal(rows[0].key, 'moderator');
    const audit = await lastAudit(admin.userId);
    assert.equal(audit.action, 'group');
    assert.equal(audit.count, 5);
    assert.equal(audit.ok, 2);
    assert.deepEqual(audit.ids.slice(0, 2), [a.userId, b.userId]);
    const roleAudit = await query("SELECT 1 FROM audit_log WHERE action = 'role.changed' AND subject_user_id = $1", [a.userId]);
    assert.equal(roleAudit.rows.length, 1);
  });
});

test('bulk group change needs the group field permission and a known group', async () => {
  await withTestServer(async (port) => {
    const noGroup = await makeUser(await makeGroup({ accountFields: ['firstName'] }));
    const target = await makeUser();
    assert.equal((await post(port, noGroup.cookie, '/members-bulk/group', { ids: [target.userId], group: 'moderator' })).status, 403);
    const admin = await makeUser('admin');
    assert.equal((await post(port, admin.cookie, '/members-bulk/group', { ids: [target.userId], group: 'gibtsnicht' })).status, 400);
    const plain = await makeUser('mitglied');
    assert.equal((await post(port, plain.cookie, '/members-bulk/group', { ids: [target.userId], group: 'moderator' })).status, 403);
  });
});

test('bulk deactivate and reactivate: own account refused, others done, sessions dropped', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const a = await makeUser();
    const res = await post(port, admin.cookie, '/members-bulk/deactivate', { ids: [a.userId, admin.userId] });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.results[a.userId].ok, true);
    assert.equal(body.results[admin.userId].ok, false);
    assert.equal((await query('SELECT deactivated_at FROM users WHERE id = $1', [a.userId])).rows[0].deactivated_at !== null, true);
    assert.equal((await query('SELECT 1 FROM sessions WHERE user_id = $1', [a.userId])).rows.length, 0);
    assert.equal((await lastAudit(admin.userId)).action, 'deactivate');

    const back = await (await post(port, admin.cookie, '/members-bulk/reactivate', { ids: [a.userId] })).json();
    assert.equal(back.ok, 1);
    assert.equal((await query('SELECT deactivated_at FROM users WHERE id = $1', [a.userId])).rows[0].deactivated_at, null);
    assert.equal((await lastAudit(admin.userId)).action, 'reactivate');

    const plain = await makeUser('mitglied');
    assert.equal((await post(port, plain.cookie, '/members-bulk/deactivate', { ids: [a.userId] })).status, 403);
  });
});

test('bulk registration action uses the single-action rules and permission', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const { rows: ev } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Bulk Con', '2027-09-01', true) RETURNING id");
    const eventId = ev[0].id;
    const pending = await makeUser();
    const cancelled = await makeUser();
    const none = await makeUser();
    await query("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'pending')", [pending.userId, eventId]);
    await query("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'cancelled')", [cancelled.userId, eventId]);

    const res = await post(port, admin.cookie, '/members-bulk/registration', { eventId, action: 'cancel', ids: [pending.userId, cancelled.userId, none.userId] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, 1);
    assert.equal(body.results[pending.userId].ok, true);
    assert.equal(body.results[cancelled.userId].ok, false);
    assert.equal(body.results[none.userId].ok, false);
    assert.equal((await query('SELECT status FROM registrations WHERE user_id = $1', [pending.userId])).rows[0].status, 'cancelled');
    const audit = await lastAudit(admin.userId);
    assert.equal(audit.action, 'registration.cancel');
    assert.equal(audit.eventId, eventId);

    assert.equal((await post(port, admin.cookie, '/members-bulk/registration', { eventId, action: 'bogus', ids: [none.userId] })).status, 400);
    assert.equal((await post(port, admin.cookie, '/members-bulk/registration', { eventId: crypto.randomUUID(), action: 'cancel', ids: [none.userId] })).status, 404);

    const noOverride = await makeUser(await makeGroup({ override: false }));
    assert.equal((await post(port, noOverride.cookie, '/members-bulk/registration', { eventId, action: 'cancel', ids: [none.userId] })).status, 403);
  });
});

test('bulk endpoints validate ids and enforce the 500 limit', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    assert.equal((await post(port, admin.cookie, '/members-bulk/deactivate', { ids: [] })).status, 400);
    assert.equal((await post(port, admin.cookie, '/members-bulk/deactivate', { ids: 'x' })).status, 400);
    const many = Array.from({ length: 501 }, () => crypto.randomUUID());
    assert.equal((await post(port, admin.cookie, '/members-bulk/deactivate', { ids: many })).status, 413);
  });
});
