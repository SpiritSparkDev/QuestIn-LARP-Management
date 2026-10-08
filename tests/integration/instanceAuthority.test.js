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
const authority = await import('../../backend/instanceAuthority/repository.js');
await query('DELETE FROM instance_authority WHERE event_id IS NOT NULL');

async function makeUser(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Inst', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`inst-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent() {
  const { rows } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Inst Con', '2027-09-01', true) RETURNING id");
  return rows[0].id;
}

test('instance id is created once and stays stable', async () => {
  const a = await authority.getInstanceId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(await authority.getInstanceId(), a);
});

test('an event without a row is primary', async () => {
  const state = await authority.getState(await makeEvent());
  assert.equal(state.role, 'primary');
  assert.equal(state.generation, 0);
});

test('primary -> delegated -> primary, generation counts each handover and the log records it', async () => {
  const eventId = await makeEvent();
  const { userId } = await makeUser('admin');
  const d = await authority.delegate(eventId, userId);
  assert.equal(d.role, 'delegated');
  assert.equal(d.generation, 1);
  assert.ok(d.snapshotId && d.snapshotTakenAt && d.delegatedAt);
  assert.equal(d.delegatedBy, userId);
  const r = await authority.returnToPrimary(eventId, userId);
  assert.equal(r.role, 'primary');
  assert.equal(r.generation, 2);
  const { rows } = await query('SELECT result FROM snapshot_log WHERE event_id = $1', [eventId]);
  assert.deepEqual(rows.map((x) => x.result).sort(), ['delegated', 'returned']);
});

test('forbidden transitions are rejected with INVALID_TRANSITION', async () => {
  const eventId = await makeEvent();
  const { userId } = await makeUser('admin');
  await assert.rejects(authority.returnToPrimary(eventId, userId), { code: 'INVALID_TRANSITION' });
  await assert.rejects(authority.forceRelease(eventId, userId), { code: 'INVALID_TRANSITION' });
  await assert.rejects(authority.retire(eventId), { code: 'INVALID_TRANSITION' });
  await authority.delegate(eventId, userId);
  await assert.rejects(authority.delegate(eventId, userId), { code: 'INVALID_TRANSITION' });
  await assert.rejects(authority.becomeOfflinePrimary(eventId, { snapshotId: crypto.randomUUID(), snapshotTakenAt: new Date() }), { code: 'INVALID_TRANSITION' });
});

test('force release invalidates the snapshot and logs "forced"', async () => {
  const eventId = await makeEvent();
  const { userId } = await makeUser('admin');
  const d = await authority.delegate(eventId, userId);
  const r = await authority.forceRelease(eventId, userId);
  assert.equal(r.role, 'primary');
  assert.equal(r.snapshotId, null);
  const { rows } = await query("SELECT snapshot_id FROM snapshot_log WHERE event_id = $1 AND result = 'forced'", [eventId]);
  assert.equal(rows[0].snapshot_id, d.snapshotId);
});

test('offline side: primary -> offline_primary -> retired, retired is final', async () => {
  const eventId = await makeEvent();
  const snapshotId = crypto.randomUUID();
  const s = await authority.becomeOfflinePrimary(eventId, { snapshotId, snapshotTakenAt: new Date('2027-09-01T10:00:00Z') });
  assert.equal(s.role, 'offline_primary');
  assert.equal(s.snapshotId, snapshotId);
  await assert.rejects(authority.becomeOfflinePrimary(eventId, { snapshotId, snapshotTakenAt: new Date() }), { code: 'INVALID_TRANSITION' });
  assert.equal((await authority.retire(eventId)).role, 'retired');
  await assert.rejects(authority.retire(eventId), { code: 'INVALID_TRANSITION' });
});

test('summary reports the non-primary event state and open conflicts', async () => {
  const eventId = await makeEvent();
  const { userId } = await makeUser('admin');
  const d = await authority.delegate(eventId, userId);
  await query("INSERT INTO sync_conflicts (snapshot_id, generation, type, entity) VALUES ($1, 1, 'balance_mismatch', 'tavern_account')", [d.snapshotId]);
  const s = await authority.getSummary();
  assert.equal(s.role, 'delegated');
  assert.ok(s.snapshotTakenAt && s.delegatedSince);
  assert.ok(s.openConflicts >= 1);
  await authority.returnToPrimary(eventId, userId);
});

test('write guard: delegated event answers 423 on check-in/checkout/tavern writes, reads and others pass', async () => {
  const eventId = await makeEvent();
  const other = await makeEvent();
  const admin = await makeUser('admin');
  await authority.delegate(eventId, admin.userId);
  const call = (port, method, path, body) => fetch(`http://localhost:${port}${path}`, {
    method, headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  await withTestServer(async (port) => {
    for (const [m, p] of [
      ['POST', `/events/${eventId}/checkin`], ['POST', `/events/${eventId}/checkout`], ['PUT', `/events/${eventId}/checkin/${crypto.randomUUID()}`],
      ['POST', '/tavern/accounts'], ['POST', `/tavern/accounts/${crypto.randomUUID()}/charge`], ['POST', `/tavern/transactions/${crypto.randomUUID()}/void`],
    ]) {
      const res = await call(port, m, p, { userId: crypto.randomUUID() });
      assert.equal(res.status, 423, `${m} ${p}`);
      assert.match((await res.json()).error, /laufen gerade offline \(Snapshot vom /);
    }
    assert.notEqual((await call(port, 'GET', '/tavern/items')).status, 423);
    assert.notEqual((await call(port, 'GET', `/events/${eventId}`)).status, 423);
    // another event's check-in is untouched
    assert.notEqual((await call(port, 'POST', `/events/${other}/checkin`, { userId: crypto.randomUUID() })).status, 423);
    const account = await (await call(port, 'GET', '/account')).json();
    assert.equal(account.instance.role, 'delegated');
    assert.ok(account.instance.snapshotTakenAt && account.instance.delegatedSince);
    assert.equal(typeof account.instance.openConflicts, 'number');
  });
  await authority.returnToPrimary(eventId, admin.userId);
  await withTestServer(async (port) => {
    assert.notEqual((await call(port, 'POST', `/events/${eventId}/checkin`, { userId: crypto.randomUUID() })).status, 423);
  });
});

// Delegations are instance-wide for tavern writes; don't leak them into other test files.
test.after(async () => {
  await query('DELETE FROM instance_authority WHERE event_id IS NOT NULL');
  await closePool();
});
