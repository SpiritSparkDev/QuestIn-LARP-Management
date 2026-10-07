import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

// Online = the global db (shared test database); offline = a fresh empty database behind its own pool.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const ONLINE_URL = process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.DATABASE_URL = ONLINE_URL;
const OFFLINE_NAME = `pakyrion_offline_${crypto.randomBytes(4).toString('hex')}`;
const OFFLINE_URL = ONLINE_URL.replace(/\/[^/]*$/, `/${OFFLINE_NAME}`);

const admin = new pg.Client({ connectionString: ONLINE_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${OFFLINE_NAME}`);
execFileSync(process.execPath, ['db/migrate.js'], { env: { ...process.env, DATABASE_URL: OFFLINE_URL } });

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const online = await import('../../backend/db.js');
const authority = await import('../../backend/instanceAuthority/repository.js');
const { exportSnapshot, importSnapshot, exportReturnPackage } = await import('../../backend/offlinePackage/snapshot.js');
const { mergeReturnBuffer } = await import('../../backend/offlineMerge/merge.js');

const pool = new pg.Pool({ connectionString: OFFLINE_URL });
const off = {
  query: (t, p) => pool.query(t, p),
  async withTransaction(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  },
};
const offlineAuthority = {
  becomeOfflinePrimary: (eventId, { snapshotId, snapshotTakenAt }) => off.query(
    "INSERT INTO instance_authority (event_id, role, snapshot_id, snapshot_taken_at, delegated_at) VALUES ($1, 'offline_primary', $2, $3, $3)", [eventId, snapshotId, snapshotTakenAt]),
};

const ids = { event: null, snapshot: null, users: [] };
after(async () => {
  await online.query('DELETE FROM snapshot_log WHERE snapshot_id = $1', [ids.snapshot]);
  await online.query('DELETE FROM offline_merges WHERE snapshot_id = $1', [ids.snapshot]);
  await online.query('DELETE FROM events WHERE id = $1', [ids.event]);
  await online.query("DELETE FROM audit_log WHERE action = 'roundtrip.test'");
  await online.query('DELETE FROM users WHERE id = ANY($1)', [ids.users]);
  await online.closePool();
  await pool.end();
  await admin.query(`DROP DATABASE ${OFFLINE_NAME} WITH (FORCE)`);
  await admin.end();
});

test('snapshot -> empty offline db -> work offline -> interim + final return -> online primary again', async () => {
  const q = online.query;
  const tag = crypto.randomBytes(3).toString('hex');
  const staffGroup = (await q(`INSERT INTO groups (key, name, visible_menus, account_fields) VALUES ($1, 'Helfer', '["checkin"]', '[]') RETURNING id`, [`rt_helper_${tag}`])).rows[0].id;
  ids.event = (await q("INSERT INTO events (name, event_date, is_active) VALUES ('Round Trip', '2027-09-01', true) RETURNING id")).rows[0].id;
  const helper = (await q(`INSERT INTO users (email, password_hash, first_name, last_name, group_id, email_verified) VALUES ($1, 'H', 'He', 'Lp', $2, true) RETURNING id`, [`rt-h-${tag}@example.com`, staffGroup])).rows[0].id;
  const player = (await q(`INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Pla', 'Yer', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id`, [`rt-p-${tag}@example.com`])).rows[0].id;
  ids.users.push(helper, player);
  await q("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'confirmed')", [player, ids.event]);
  const account = (await q('INSERT INTO tavern_accounts (event_id, number, user_id, balance_cents) VALUES ($1, 1, $2, 700) RETURNING id', [ids.event, player])).rows[0].id;
  await q("INSERT INTO tavern_transactions (account_id, type, amount_cents, created_by) VALUES ($1, 'topup', 1000, $2), ($1, 'charge', -300, $2)", [account, helper]);

  const delegation = await authority.delegate(ids.event, helper);
  ids.snapshot = delegation.snapshotId;
  const snapshot = await exportSnapshot(online, ids.event, 'pw');
  await importSnapshot(off, snapshot, 'pw', offlineAuthority);

  // --- on site: check in, charge, walk-in
  await off.query("UPDATE registrations SET status = 'checked_in', checked_in_at = now() WHERE user_id = $1", [player]);
  await off.query("INSERT INTO tavern_transactions (account_id, type, amount_cents, created_by) VALUES ($1, 'charge', -200, $2)", [account, helper]);
  await off.query('UPDATE tavern_accounts SET balance_cents = 500 WHERE id = $1', [account]);

  const interim = await mergeReturnBuffer(online, await exportReturnPackage(off, 'rp'), 'rp', { userId: helper, interim: true });
  assert.equal(interim.status, 'interim');
  assert.equal(interim.report.checkIns, 1);
  assert.equal(interim.report.newTransactions, 1);
  assert.equal((await authority.getState(ids.event)).role, 'delegated');
  assert.equal((await q('SELECT balance_cents FROM tavern_accounts WHERE id = $1', [account])).rows[0].balance_cents, 500);

  const walkin = (await off.query("INSERT INTO tavern_accounts (event_id, number, label, balance_cents) VALUES ($1, 2, 'Walkin', 100) RETURNING id", [ids.event])).rows[0].id;
  await off.query("INSERT INTO tavern_transactions (account_id, type, amount_cents, created_by) VALUES ($1, 'topup', 100, $2)", [walkin, helper]);
  await off.query("INSERT INTO audit_log (action, details) VALUES ('roundtrip.test', '{}')");

  const finalPackage = await exportReturnPackage(off, 'rp');
  const final = await mergeReturnBuffer(online, finalPackage, 'rp', { userId: helper });
  assert.equal(final.status, 'released');
  assert.equal(final.report.newAccounts, 1);
  assert.equal(final.report.balanceSumCents, 600);
  assert.equal(final.report.auditEntries, 1);
  assert.equal((await q('SELECT balance_cents FROM tavern_accounts WHERE id = $1', [walkin])).rows[0].balance_cents, 100);
  assert.equal((await q('SELECT status FROM registrations WHERE user_id = $1', [player])).rows[0].status, 'checked_in');
  assert.equal((await authority.getState(ids.event)).role, 'primary');

  assert.equal((await mergeReturnBuffer(online, finalPackage, 'rp', { userId: helper })).status, 'already_applied');
  assert.equal((await q('SELECT count(*)::int n FROM tavern_transactions WHERE account_id = ANY($1)', [[account, walkin]])).rows[0].n, 4);
});
