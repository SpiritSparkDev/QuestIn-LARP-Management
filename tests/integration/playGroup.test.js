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

async function makeUser(groupKey = 'mitglied', extra = {}) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified, managed_by_user_id) VALUES ($1, 'Pg', 'Test', (SELECT id FROM groups WHERE key = $2), true, $3) RETURNING id",
    [`playgrp-${crypto.randomUUID()}@example.com`, groupKey, extra.managedBy ?? null]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}
const parentOf = async (id) => (await query('SELECT group_parent_id FROM users WHERE id = $1', [id])).rows[0].group_parent_id;

test('admin puts members into a play group, moves them and takes them out; rules are enforced; bulk reports per member', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUser('admin');
    const [leader, other, a, b] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
    const managed = await makeUser('mitglied', { managedBy: other.userId });
    const put = (cookie, id, managerId) => fetch(`${base}/members/${id}/play-group`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ managerId }) });

    assert.equal((await put(a.cookie, a.userId, leader.userId)).status, 403); // admin only
    assert.equal((await put(admin.cookie, a.userId, leader.userId)).status, 200);
    assert.equal(await parentOf(a.userId), leader.userId);

    // the leader now runs a group: cannot join another one; nobody can join a member of a group
    assert.equal((await put(admin.cookie, leader.userId, other.userId)).status, 409);
    assert.equal((await put(admin.cookie, b.userId, a.userId)).status, 409);
    assert.equal((await put(admin.cookie, a.userId, a.userId)).status, 409);
    assert.equal((await put(admin.cookie, managed.userId, leader.userId)).status, 409); // managed person follows its manager

    // move to another group, then out
    assert.equal((await put(admin.cookie, a.userId, other.userId)).status, 200);
    assert.equal(await parentOf(a.userId), other.userId);
    assert.equal((await put(admin.cookie, a.userId, null)).status, 200);
    assert.equal(await parentOf(a.userId), null);

    // bulk: b joins fine, a leader (named group) is reported as failed
    await query("UPDATE users SET group_name = 'Die Leitung' WHERE id = $1", [leader.userId]);
    const bulk = await fetch(`${base}/members-bulk/play-group`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: JSON.stringify({ ids: [b.userId, leader.userId], managerId: other.userId }) });
    const res = await bulk.json();
    assert.equal(res.ok, 1);
    assert.equal(res.results[leader.userId].ok, false);
    assert.equal(await parentOf(b.userId), other.userId);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'playgrp-%'");
  await closePool();
});
