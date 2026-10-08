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

const db = await import('../../backend/db.js');
const { query, closePool } = db;
const { createSession } = await import('../../backend/auth/sessions.js');
const authority = await import('../../backend/instanceAuthority/repository.js');
const container = await import('../../backend/offlinePackage/container.js');
const { readPackage } = await import('../../backend/offlinePackage/snapshot.js');
await query('DELETE FROM instance_authority WHERE event_id IS NOT NULL');

const SCHEMA = (await query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')).rows[0].filename;
const mine = { events: [], snapshots: [], users: [] };
const PW = 'passphrase-1';

after(async () => {
  await query('DELETE FROM sync_conflicts WHERE snapshot_id = ANY($1)', [mine.snapshots]);
  await query('DELETE FROM offline_merges WHERE snapshot_id = ANY($1)', [mine.snapshots]);
  await query('DELETE FROM snapshot_log WHERE snapshot_id = ANY($1)', [mine.snapshots]);
  await query('DELETE FROM events WHERE id = ANY($1)', [mine.events]);
  await query("DELETE FROM audit_log WHERE action IN ('offline_snapshot', 'offline_return', 'offline_force_release', 'sync_conflict_resolved', 'offline_return_package') AND actor_id = ANY($1)", [mine.users]);
  await query('DELETE FROM users WHERE id = ANY($1)', [mine.users]);
  await closePool();
});

async function makeUser(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Rou', 'Te', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`routes-${crypto.randomUUID()}@example.com`, groupKey]);
  mine.users.push(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}
const makeEvent = async (name = 'Routen Con') => {
  const id = (await query("INSERT INTO events (name, event_date, is_active) VALUES ($1, '2027-09-01', true) RETURNING id", [name])).rows[0].id;
  mine.events.push(id);
  return id;
};

const api = (port) => (method, path, { cookie, body, headers } = {}) => fetch(`http://localhost:${port}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }), ...headers }, body: method === 'GET' ? undefined : body && JSON.stringify(body),
});

function sealReturn(snapshotId, eventId, generation, data = {}) {
  return container.seal({
    manifest: { kind: 'return', snapshot_id: snapshotId, taken_at: new Date(), instance_id: crypto.randomUUID(), schema_version: SCHEMA, generation, return_token: container.returnToken(snapshotId), event_id: eventId },
    data: { registrations: [], tavern_accounts: [], tavern_transactions: [], audit_log: [], ...data },
  }, PW).toString('base64');
}

test('all routes need the admin group', async () => {
  const member = await makeUser('mitglied');
  await withTestServer(async (port) => {
    const call = api(port);
    for (const [method, path] of [['GET', '/offline/status'], ['POST', '/offline/snapshot'], ['GET', '/offline/conflicts'], ['GET', '/offline/conflicts.csv'], ['POST', '/offline/return-import']]) {
      assert.equal((await call(method, path)).status, 401, path);
      assert.equal((await call(method, path, { cookie: member.cookie, body: {} })).status, 403, path);
    }
  });
});

test('snapshot delegates the event and returns a readable .qpkg; second call is refused; status lists it', async () => {
  const admin = await makeUser('admin');
  const eventId = await makeEvent('Routen Con 1');
  await withTestServer(async (port) => {
    const call = api(port);
    assert.equal((await call('POST', '/offline/snapshot', { cookie: admin.cookie, body: { eventId, passphrase: 'kurz' } })).status, 400);
    assert.equal((await call('POST', '/offline/snapshot', { cookie: admin.cookie, body: { eventId: crypto.randomUUID(), passphrase: PW } })).status, 404);

    const res = await call('POST', '/offline/snapshot', { cookie: admin.cookie, body: { eventId, passphrase: PW } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /questin-offline-routen-con-1-\d{4}-\d{2}-\d{2}\.qpkg/);
    const snapshotId = res.headers.get('x-snapshot-id');
    mine.snapshots.push(snapshotId);
    const pkg = await readPackage(db, Buffer.from(await res.arrayBuffer()), PW, 'snapshot');
    assert.equal(pkg.manifest.snapshot_id, snapshotId);
    assert.equal((await authority.getState(eventId)).role, 'delegated');
    assert.equal((await call('POST', '/offline/snapshot', { cookie: admin.cookie, body: { eventId, passphrase: PW } })).status, 409);

    const status = await (await call('GET', '/offline/status', { cookie: admin.cookie })).json();
    assert.equal(status.mode, 'online');
    const ev = status.events.find((e) => e.eventId === eventId);
    assert.equal(ev.role, 'delegated');
    assert.equal(ev.snapshotId, snapshotId);
    assert.ok(status.instance.delegatedSince);
    assert.ok(Array.isArray(status.conflicts));
    assert.equal((await query("SELECT count(*)::int n FROM audit_log WHERE action = 'offline_snapshot' AND details->>'eventId' = $1", [eventId])).rows[0].n, 1);
  });
});

test('release: refused with open conflicts, release-force needs confirm and keeps the conflicts', async () => {
  const admin = await makeUser('admin');
  const eventId = await makeEvent();
  const state = await authority.delegate(eventId, admin.userId);
  mine.snapshots.push(state.snapshotId);
  const cancelled = await makeUser('mitglied');
  await query("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'cancelled')", [cancelled.userId, eventId]);
  await withTestServer(async (port) => {
    const call = api(port);
    const file = sealReturn(state.snapshotId, eventId, state.generation, {
      registrations: [{ user_id: cancelled.userId, event_id: eventId, status: 'checked_in', checked_in_at: new Date(), checked_out_at: null }],
    });
    const imp = await (await call('POST', '/offline/return-import', { cookie: admin.cookie, body: { file, passphrase: PW } })).json();
    assert.equal(imp.status, 'conflicts');
    assert.equal(imp.conflicts[0].type, 'registration_changed_online');
    assert.equal((await call('POST', '/offline/release', { cookie: admin.cookie, body: { eventId } })).status, 409);
    assert.equal((await call('POST', '/offline/release-force', { cookie: admin.cookie, body: { eventId } })).status, 400);
    const forced = await call('POST', '/offline/release-force', { cookie: admin.cookie, body: { eventId, confirm: true } });
    assert.deepEqual(await forced.json(), { released: true, openConflicts: 1 });
    assert.equal((await authority.getState(eventId)).role, 'primary');
    assert.equal((await call('POST', '/offline/release', { cookie: admin.cookie, body: { eventId } })).status, 409, 'not delegated any more');
  });
});

test('release without conflicts', async () => {
  const admin = await makeUser('admin');
  const eventId = await makeEvent();
  mine.snapshots.push((await authority.delegate(eventId, admin.userId)).snapshotId);
  await withTestServer(async (port) => {
    const res = await api(port)('POST', '/offline/release', { cookie: admin.cookie, body: { eventId } });
    assert.deepEqual(await res.json(), { released: true });
    assert.equal((await authority.getState(eventId)).role, 'primary');
  });
});

test('return-import, conflict list / csv and resolve route end to end', async () => {
  const admin = await makeUser('admin');
  const eventId = await makeEvent();
  const state = await authority.delegate(eventId, admin.userId);
  mine.snapshots.push(state.snapshotId);
  const player = await makeUser('mitglied');
  await query("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'cancelled')", [player.userId, eventId]);
  await withTestServer(async (port) => {
    const call = api(port);
    const reg = { user_id: player.userId, event_id: eventId, status: 'checked_in', checked_in_at: new Date(), checked_out_at: null };
    assert.equal((await call('POST', '/offline/return-import', { cookie: admin.cookie, body: { file: sealReturn(state.snapshotId, eventId, state.generation, { registrations: [reg] }), passphrase: 'wrong-pass' } })).status, 400);
    assert.equal((await call('POST', '/offline/return-import', { cookie: admin.cookie, body: { file: sealReturn(crypto.randomUUID(), eventId, state.generation), passphrase: PW } })).status, 409);

    const file = sealReturn(state.snapshotId, eventId, state.generation, { registrations: [reg] });
    const imp = await (await call('POST', '/offline/return-import', { cookie: admin.cookie, body: { file, passphrase: PW } })).json();
    assert.equal(imp.status, 'conflicts');
    assert.equal(imp.report.conflicts, 1);
    assert.equal((await (await call('POST', '/offline/return-import', { cookie: admin.cookie, body: { file, passphrase: PW } })).json()).status, 'already_applied');

    const open = (await (await call('GET', '/offline/conflicts?status=open', { cookie: admin.cookie })).json()).conflicts.filter((c) => c.snapshotId === state.snapshotId);
    assert.equal(open.length, 1);
    assert.deepEqual(open[0].allowedResolutions, ['offline', 'online', 'ignored']);
    assert.equal(open[0].offlineValue.status, 'checked_in');
    const csv = await (await call('GET', '/offline/conflicts.csv?status=open', { cookie: admin.cookie })).text();
    assert.ok(csv.includes('registration_changed_online') && csv.includes(player.userId));

    assert.equal((await call('POST', `/offline/conflicts/${open[0].id}/resolve`, { cookie: admin.cookie, body: { resolution: 'merged' } })).status, 400);
    const done = await (await call('POST', `/offline/conflicts/${open[0].id}/resolve`, { cookie: admin.cookie, body: { resolution: 'offline', note: 'ok' } })).json();
    assert.equal(done.released, true);
    assert.equal(done.conflict.status, 'resolved');
    assert.equal((await call('POST', `/offline/conflicts/${open[0].id}/resolve`, { cookie: admin.cookie, body: { resolution: 'offline' } })).status, 409);
    assert.equal((await authority.getState(eventId)).role, 'primary');
    const resolved = (await (await call('GET', '/offline/conflicts?status=resolved&type=registration_changed_online', { cookie: admin.cookie })).json()).conflicts;
    assert.ok(resolved.some((c) => c.id === open[0].id));
  });
});

test('token import: no login, token usable once per package, next generation works, wrong token refused', async () => {
  const admin = await makeUser('admin');
  const eventId = await makeEvent();
  const state = await authority.delegate(eventId, admin.userId);
  mine.snapshots.push(state.snapshotId);
  const token = container.returnToken(state.snapshotId);
  await withTestServer(async (port) => {
    const call = api(port);
    const push = (file, headers = { 'X-Return-Token': token }) => call('POST', '/offline/return-import-token', { headers, body: { file, passphrase: PW, interim: true } });
    const first = sealReturn(state.snapshotId, eventId, state.generation);
    assert.equal((await push(first, {})).status, 401);
    assert.equal((await push(first, { 'X-Return-Token': 'f'.repeat(64) })).status, 401);
    const ok = await push(first);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'interim');
    const again = await push(first);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'TOKEN_USED');
    assert.equal((await push(sealReturn(state.snapshotId, eventId, state.generation + 1))).status, 200, 'the next package of the same snapshot may use the token again');
    assert.equal((await authority.getState(eventId)).role, 'delegated');
  });
});

async function offlineEvent(role = 'offline_primary') {
  const eventId = await makeEvent('Offline Side');
  const snapshotId = crypto.randomUUID();
  mine.snapshots.push(snapshotId);
  await authority.becomeOfflinePrimary(eventId, { snapshotId, snapshotTakenAt: new Date(Date.now() - 3600_000) });
  await query('UPDATE instance_authority SET generation = 4 WHERE event_id = $1', [eventId]);
  if (role === 'retired') await authority.retire(eventId);
  return { eventId, snapshotId };
}

test('return-package (offline instance): interim export raises the generation, final retires', async () => {
  const admin = await makeUser('admin');
  await query('DELETE FROM instance_authority WHERE event_id IS NOT NULL');
  const { eventId, snapshotId } = await offlineEvent();
  await withTestServer(async (port) => {
    const call = api(port);
    assert.equal((await call('POST', '/offline/return-package', { cookie: admin.cookie, body: { passphrase: 'x' } })).status, 400);
    const read = async (res) => readPackage(db, Buffer.from(await res.arrayBuffer()), PW, 'return');
    const interim = await read(await call('POST', '/offline/return-package', { cookie: admin.cookie, body: { passphrase: PW } }));
    assert.equal(interim.manifest.generation, 4);
    assert.equal((await authority.getState(eventId)).role, 'offline_primary');
    const final = await read(await call('POST', '/offline/return-package', { cookie: admin.cookie, body: { passphrase: PW, final: true } }));
    assert.equal(final.manifest.generation, 5);
    assert.equal(final.manifest.snapshot_id, snapshotId);
    assert.equal((await authority.getState(eventId)).role, 'retired');
  });
  await query('DELETE FROM instance_authority WHERE event_id = $1', [eventId]);
});

test('return-push: unreachable server keeps the instance writable; reachable one gets package + token', async () => {
  const admin = await makeUser('admin');
  await query('DELETE FROM instance_authority WHERE event_id IS NOT NULL');
  const { eventId, snapshotId } = await offlineEvent();
  const realFetch = globalThis.fetch;
  const seen = [];
  let online = false;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://online.example')) return realFetch(url, init);
    seen.push({ url: String(url), init });
    if (!online) throw new Error('getaddrinfo ENOTFOUND');
    if (String(url).endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
    return new Response(JSON.stringify({ status: 'released', report: null, conflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await withTestServer(async (port) => {
      const call = api(port);
      const body = { onlineUrl: 'https://online.example/', passphrase: PW, final: true };
      assert.equal((await call('POST', '/offline/return-push', { cookie: admin.cookie, body: { ...body, onlineUrl: 'ftp://x' } })).status, 400);
      const down = await call('POST', '/offline/return-push', { cookie: admin.cookie, body });
      assert.equal(down.status, 502);
      assert.equal((await down.json()).reachable, false);
      assert.equal((await authority.getState(eventId)).role, 'offline_primary');

      online = true;
      const up = await call('POST', '/offline/return-push', { cookie: admin.cookie, body });
      assert.equal(up.status, 200);
      assert.equal((await up.json()).result.status, 'released');
      const post = seen.filter((c) => c.url === 'https://online.example/offline/return-import-token').at(-1);
      assert.equal(post.init.headers['X-Return-Token'], container.returnToken(snapshotId));
      const sent = JSON.parse(post.init.body);
      assert.equal(sent.interim, false);
      assert.equal(container.open(Buffer.from(sent.file, 'base64'), PW).manifest.snapshot_id, snapshotId);
      assert.equal((await authority.getState(eventId)).role, 'retired');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  await query('DELETE FROM instance_authority WHERE event_id = $1', [eventId]);
});
