import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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
const authority = await import('../../backend/instanceAuthority/repository.js');
const container = await import('../../backend/offlinePackage/container.js');
const { mergeReturnPackage, resolveConflict, emergencyRelease } = await import('../../backend/offlineMerge/merge.js');
await query('DELETE FROM instance_authority WHERE event_id IS NOT NULL');

const SCHEMA = (await query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')).rows[0].filename;
const mine = { events: [], snapshots: [], users: [] };

after(async () => {
  await query('DELETE FROM sync_conflicts WHERE snapshot_id = ANY($1)', [mine.snapshots]);
  await query('DELETE FROM offline_merges WHERE snapshot_id = ANY($1)', [mine.snapshots]);
  await query('DELETE FROM snapshot_log WHERE snapshot_id = ANY($1)', [mine.snapshots]);
  await query('DELETE FROM events WHERE id = ANY($1)', [mine.events]);
  await query('DELETE FROM audit_log WHERE action = $1', ['merge.test']);
  await query('DELETE FROM users WHERE id = ANY($1)', [mine.users]);
  await closePool();
});

async function makeUser(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mer', 'Ge', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`merge-${crypto.randomUUID()}@example.com`, groupKey]);
  mine.users.push(rows[0].id);
  return rows[0].id;
}

async function scenario() {
  const eventId = (await query("INSERT INTO events (name, event_date, is_active) VALUES ('Merge Con', '2027-09-01', true) RETURNING id")).rows[0].id;
  const adminId = await makeUser('admin');
  const st = await authority.delegate(eventId, adminId);
  mine.events.push(eventId);
  mine.snapshots.push(st.snapshotId);
  return { eventId, adminId, snapshotId: st.snapshotId, generation: st.generation };
}

const addReg = async (s, status = 'confirmed') => {
  const userId = await makeUser();
  await query('INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, $3)', [userId, s.eventId, status]);
  return userId;
};
const addAccount = async (s, number, balance, label = null, userId = null) => {
  const { rows } = await query(
    'INSERT INTO tavern_accounts (event_id, number, balance_cents, label, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [s.eventId, number, balance, label, userId]);
  return rows[0].id;
};
const addTx = async (accountId, type, amount) => (await query(
  'INSERT INTO tavern_transactions (account_id, type, amount_cents) VALUES ($1, $2, $3) RETURNING id', [accountId, type, amount])).rows[0].id;

const NOW = () => new Date().toISOString();
const acc = (s, number, balance, extra = {}) => ({
  id: crypto.randomUUID(), event_id: s.eventId, number, user_id: null, label: null, balance_cents: balance, locked: false, created_at: NOW(), ...extra,
});
const tx = (accountId, type, amount, extra = {}) => ({
  id: crypto.randomUUID(), account_id: accountId, type, amount_cents: amount, method: null, note: null, items: null,
  reverses_id: null, voided_at: null, created_by: null, created_at: NOW(), ...extra,
});
const checkedIn = (s, userId) => ({ user_id: userId, event_id: s.eventId, status: 'checked_in', checked_in_at: NOW(), checked_out_at: null });

function pkgOf(s, { generation = s.generation, takenAt = new Date(), snapshotId = s.snapshotId, registrations = [], accounts = [], txs = [], audit = [], mails } = {}) {
  return JSON.parse(JSON.stringify({
    manifest: {
      kind: 'return', snapshot_id: snapshotId, taken_at: takenAt, instance_id: crypto.randomUUID(), schema_version: SCHEMA,
      generation, return_token: container.returnToken(snapshotId), event_id: s.eventId,
    },
    data: { registrations, tavern_accounts: accounts, tavern_transactions: txs, audit_log: audit, ...(mails ? { mail_outbox: mails } : {}) },
  }));
}

const roleOf = async (s) => (await authority.getState(s.eventId)).role;
const regStatus = async (s, userId) => (await query('SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2', [userId, s.eventId])).rows[0]?.status;
const conflictsOf = async (s, type) => (await query('SELECT * FROM sync_conflicts WHERE snapshot_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY created_at, id', [s.snapshotId, type ?? null])).rows;

test('clean merge: check-ins, accounts, ledger, void marks, audit; online released; repeat is a no-op', async () => {
  const s = await scenario();
  const player = await addReg(s);
  const a = await addAccount(s, 1, 1000, null, player);
  await addTx(a, 'topup', 1000);
  const b = await addAccount(s, 2, 500);
  await addTx(b, 'topup', 500);
  const c = await addAccount(s, 3, 300);
  await addTx(c, 'topup', 400);
  const c3 = await addTx(c, 'charge', -100);
  const onlineTx = async (id) => (await query('SELECT id, account_id, type, amount_cents FROM tavern_transactions WHERE id = $1', [id])).rows[0];
  const aTopup = (await query("SELECT id FROM tavern_transactions WHERE account_id = $1", [a])).rows[0].id;
  const bTopup = (await query("SELECT id FROM tavern_transactions WHERE account_id = $1", [b])).rows[0].id;
  const cTopup = (await query("SELECT id FROM tavern_transactions WHERE account_id = $1 AND type = 'topup'", [c])).rows[0].id;
  const base = (id, accountId, type, amount) => ({ ...tx(accountId, type, amount), id });
  const n = acc(s, 4, 250, { label: 'Willi' });
  const c2 = tx(b, 'charge', -200, { voided_at: NOW() });
  const pkg = pkgOf(s, {
    registrations: [checkedIn(s, player)],
    accounts: [{ ...(await query('SELECT * FROM tavern_accounts WHERE id = $1', [a])).rows[0], balance_cents: 700 },
      { ...(await query('SELECT * FROM tavern_accounts WHERE id = $1', [b])).rows[0] },
      { ...(await query('SELECT * FROM tavern_accounts WHERE id = $1', [c])).rows[0], balance_cents: 400 }, n],
    txs: [
      base(aTopup, a, 'topup', 1000), tx(a, 'charge', -300),
      base(bTopup, b, 'topup', 500), c2, tx(b, 'void', 200, { reverses_id: c2.id }),
      base(cTopup, c, 'topup', 400), { ...base(c3, c, 'charge', -100), voided_at: NOW() }, tx(c, 'void', 100, { reverses_id: c3 }),
      tx(n.id, 'topup', 250),
    ],
    audit: [{ id: crypto.randomUUID(), created_at: NOW(), actor_id: s.adminId, action: 'merge.test', subject_user_id: null, details: { x: 1 } }],
  });
  assert.ok((await onlineTx(c3)));

  const res = await mergeReturnPackage(db, pkg, { userId: s.adminId });
  assert.equal(res.status, 'released');
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(
    { checkIns: res.report.checkIns, newAccounts: res.report.newAccounts, updatedAccounts: res.report.updatedAccounts, newTransactions: res.report.newTransactions, balanceSumCents: res.report.balanceSumCents, auditEntries: res.report.auditEntries },
    { checkIns: 1, newAccounts: 1, updatedAccounts: 3, newTransactions: 5, balanceSumCents: 1850, auditEntries: 1 });
  assert.equal(await regStatus(s, player), 'checked_in');
  assert.equal((await query('SELECT balance_cents FROM tavern_accounts WHERE id = $1', [a])).rows[0].balance_cents, 700);
  assert.ok((await query('SELECT voided_at FROM tavern_transactions WHERE id = $1', [c3])).rows[0].voided_at, 'void mark of an existing entry is carried over');
  assert.equal((await query('SELECT count(*)::int n FROM tavern_transactions WHERE account_id = $1', [n.id])).rows[0].n, 1);
  assert.equal((await query("SELECT count(*)::int n FROM audit_log WHERE action = 'merge.test'")).rows[0].n, 1);
  const state = await authority.getState(s.eventId);
  assert.equal(state.role, 'primary');
  assert.equal(state.generation, 3, 'delegate (1) -> merge (2) -> release (3)');
  assert.deepEqual((await query('SELECT result FROM snapshot_log WHERE snapshot_id = $1 ORDER BY created_at', [s.snapshotId])).rows.map((r) => r.result).sort(), ['delegated', 'returned']);

  const again = await mergeReturnPackage(db, pkg, { userId: s.adminId });
  assert.equal(again.status, 'already_applied');
  assert.equal((await query('SELECT count(*)::int n FROM tavern_transactions WHERE account_id = $1', [n.id])).rows[0].n, 1);
});

test('offline mails are carried over into the online outbox once, even if the package is merged again', async () => {
  const s = await scenario();
  const player = await addReg(s);
  const mail = { id: crypto.randomUUID(), created_at: NOW(), to_address: `offline-${player}@offline.invalid`, subject: 'Zahlung eingegangen', body: 'Danke', is_html: false, slot: 'payment_received', user_id: player };
  const pkg = pkgOf(s, { mails: [mail] });
  const res = await mergeReturnPackage(db, pkg, { userId: s.adminId, interim: true });
  assert.equal(res.report.queuedMails, 1);
  const again = pkgOf(s, { generation: s.generation + 1, mails: [mail] });
  await mergeReturnPackage(db, again, { userId: s.adminId, interim: true });
  const { rows } = await query('SELECT slot, user_id, sent_at FROM mail_outbox WHERE id = $1', [mail.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, 'payment_received');
  assert.equal(rows[0].sent_at, null, 'no SMTP in tests: stays queued');
  await query('DELETE FROM mail_outbox WHERE id = $1', [mail.id]);
});

test('registration_changed_online + unknown_entity: held back, resolvable per option, last one releases online', async () => {
  const s = await scenario();
  const [p1, p2, p3] = [await addReg(s, 'cancelled'), await addReg(s, 'cancelled'), await addReg(s, 'cancelled')];
  const p4 = await makeUser();
  const p5 = await makeUser();
  const res = await mergeReturnPackage(db, pkgOf(s, { registrations: [p1, p2, p3, p4, p5].map((u) => checkedIn(s, u)) }), { userId: s.adminId });
  assert.equal(res.status, 'conflicts');
  assert.equal(await roleOf(s), 'delegated');
  assert.equal(await regStatus(s, p1), 'cancelled');
  const changed = await conflictsOf(s, 'registration_changed_online');
  const unknown = await conflictsOf(s, 'unknown_entity');
  assert.equal(changed.length, 3);
  assert.equal(unknown.length, 2);
  const forUser = (list, u) => list.find((c) => c.entity_id === u);
  assert.equal(forUser(changed, p1).online_value.status, 'cancelled');
  assert.equal(forUser(changed, p1).offline_value.status, 'checked_in');

  await assert.rejects(resolveConflict(forUser(changed, p1).id, 'merged', s.adminId), { code: 'INVALID_RESOLUTION' });
  assert.equal((await resolveConflict(forUser(changed, p1).id, 'offline', s.adminId, 'passt')).released, false);
  await resolveConflict(forUser(changed, p2).id, 'online', s.adminId);
  await resolveConflict(forUser(changed, p3).id, 'ignored', s.adminId);
  await resolveConflict(forUser(unknown, p4).id, 'offline', s.adminId);
  await assert.rejects(resolveConflict(forUser(changed, p1).id, 'offline', s.adminId), { code: 'ALREADY_RESOLVED' });
  assert.equal(await roleOf(s), 'delegated');
  const last = await resolveConflict(forUser(unknown, p5).id, 'online', s.adminId);
  assert.equal(last.released, true);
  assert.equal(await roleOf(s), 'primary');
  assert.equal(await regStatus(s, p1), 'checked_in');
  assert.equal(await regStatus(s, p2), 'cancelled');
  assert.equal(await regStatus(s, p3), 'cancelled');
  assert.equal(await regStatus(s, p4), 'checked_in');
  assert.equal(await regStatus(s, p5), undefined);
  const c1 = (await query('SELECT status, resolution, resolved_by, note FROM sync_conflicts WHERE id = $1', [forUser(changed, p1).id])).rows[0];
  assert.deepEqual(c1, { status: 'resolved', resolution: 'offline', resolved_by: s.adminId, note: 'passt' });
  assert.equal((await query("SELECT count(*)::int n FROM audit_log WHERE action = 'sync_conflict_resolved' AND details->>'conflictId' = $1", [forUser(changed, p1).id])).rows[0].n, 1);
});

test('balance_mismatch: blocked account, resolution offline / merged / online / ignored', async () => {
  const s = await scenario();
  const accounts = [10, 11, 12, 13].map((n) => acc(s, n, 999));
  const txs = accounts.map((a) => tx(a.id, 'topup', 500));
  const res = await mergeReturnPackage(db, pkgOf(s, { accounts, txs }), { userId: s.adminId });
  assert.equal(res.status, 'conflicts');
  assert.equal((await query('SELECT count(*)::int n FROM tavern_accounts WHERE event_id = $1', [s.eventId])).rows[0].n, 0, 'nothing of the mismatching accounts is merged');
  const list = await conflictsOf(s, 'balance_mismatch');
  assert.equal(list.length, 4);
  assert.equal(list[0].offline_value.sumCents, 500);
  const byAcc = (a) => list.find((c) => c.entity_id === a.id);
  const balanceOf = async (a) => (await query('SELECT balance_cents FROM tavern_accounts WHERE id = $1', [a.id])).rows[0]?.balance_cents;
  await resolveConflict(byAcc(accounts[0]).id, 'offline', s.adminId);
  await resolveConflict(byAcc(accounts[1]).id, 'merged', s.adminId);
  await resolveConflict(byAcc(accounts[2]).id, 'online', s.adminId);
  await resolveConflict(byAcc(accounts[3]).id, 'ignored', s.adminId);
  assert.equal(await balanceOf(accounts[0]), 999, 'offline: package balance as it is');
  assert.equal(await balanceOf(accounts[1]), 500, 'merged: balance recomputed from the ledger');
  assert.equal(await balanceOf(accounts[2]), undefined);
  assert.equal(await balanceOf(accounts[3]), undefined);
  assert.equal(await roleOf(s), 'primary');
});

test('tavern_number_collision: renumbered, confirmable', async () => {
  const s = await scenario();
  await addAccount(s, 5, 0, 'online guest');
  const a = acc(s, 5, 100, { label: 'Offline Gast' });
  const res = await mergeReturnPackage(db, pkgOf(s, { accounts: [a], txs: [tx(a.id, 'topup', 100)] }), { userId: s.adminId });
  assert.equal(res.status, 'conflicts');
  assert.equal((await query('SELECT number FROM tavern_accounts WHERE id = $1', [a.id])).rows[0].number, 6);
  const [c] = await conflictsOf(s, 'tavern_number_collision');
  assert.equal(c.offline_value.originalNumber, 5);
  assert.equal(c.offline_value.newNumber, 6);
  assert.equal(c.online_value.number, 5);
  await assert.rejects(resolveConflict(c.id, 'online', s.adminId), { code: 'INVALID_RESOLUTION' });
  await resolveConflict(c.id, 'offline', s.adminId);
  assert.equal(await roleOf(s), 'primary');
});

test('account_deleted_online: kept anonymised on offline, dropped on online, closed on ignored', async () => {
  const s = await scenario();
  const gone = [1, 2, 3].map((n) => acc(s, n, 300, { user_id: crypto.randomUUID() }));
  const res = await mergeReturnPackage(db, pkgOf(s, { accounts: gone, txs: gone.map((a) => tx(a.id, 'topup', 300)) }), { userId: s.adminId });
  assert.equal(res.status, 'conflicts');
  const list = await conflictsOf(s, 'account_deleted_online');
  assert.equal(list.length, 3);
  const get = (a) => list.find((c) => c.entity_id === a.id);
  await resolveConflict(get(gone[0]).id, 'offline', s.adminId);
  await resolveConflict(get(gone[1]).id, 'online', s.adminId);
  await resolveConflict(get(gone[2]).id, 'ignored', s.adminId);
  const kept = (await query('SELECT user_id, balance_cents FROM tavern_accounts WHERE id = $1', [gone[0].id])).rows[0];
  assert.deepEqual(kept, { user_id: null, balance_cents: 300 });
  assert.equal((await query('SELECT count(*)::int n FROM tavern_transactions WHERE account_id = $1', [gone[0].id])).rows[0].n, 1);
  assert.equal((await query('SELECT count(*)::int n FROM tavern_accounts WHERE id = ANY($1)', [[gone[1].id, gone[2].id]])).rows[0].n, 0);
});

test('duplicate_walkin: both imported, merge adds the balances', async () => {
  const s = await scenario();
  const a = acc(s, 1, 200, { label: 'Hans' });
  const b = acc(s, 2, 300, { label: ' hans ' });
  const res = await mergeReturnPackage(db, pkgOf(s, { accounts: [a, b], txs: [tx(a.id, 'topup', 200), tx(b.id, 'topup', 300)] }), { userId: s.adminId });
  assert.equal(res.status, 'conflicts');
  assert.equal((await query('SELECT count(*)::int n FROM tavern_accounts WHERE event_id = $1', [s.eventId])).rows[0].n, 2);
  const [c] = await conflictsOf(s, 'duplicate_walkin');
  await assert.rejects(resolveConflict(c.id, 'online', s.adminId), { code: 'INVALID_RESOLUTION' });
  await resolveConflict(c.id, 'merged', s.adminId);
  const { rows } = await query('SELECT id, balance_cents FROM tavern_accounts WHERE event_id = $1', [s.eventId]);
  assert.deepEqual(rows, [{ id: a.id, balance_cents: 500 }]);
  assert.equal((await query('SELECT count(*)::int n FROM tavern_transactions WHERE account_id = $1', [a.id])).rows[0].n, 2);
});

test('duplicate_walkin: "offline" and "ignored" keep both accounts', async () => {
  for (const resolution of ['offline', 'ignored']) {
    const s = await scenario();
    const a = acc(s, 1, 0, { label: 'Gast' });
    const b = acc(s, 2, 0, { label: 'Gast' });
    await mergeReturnPackage(db, pkgOf(s, { accounts: [a, b] }), { userId: s.adminId });
    const [c] = await conflictsOf(s, 'duplicate_walkin');
    await resolveConflict(c.id, resolution, s.adminId);
    assert.equal((await query('SELECT count(*)::int n FROM tavern_accounts WHERE event_id = $1', [s.eventId])).rows[0].n, 2);
  }
});

test('forced_release: package of a released snapshot is not merged automatically', async () => {
  const s = await scenario();
  const p1 = await addReg(s);
  const p2 = await addReg(s);
  const a = acc(s, 1, 100);
  await authority.forceRelease(s.eventId, s.adminId);
  const res = await mergeReturnPackage(db, pkgOf(s, { registrations: [checkedIn(s, p1), checkedIn(s, p2)], accounts: [a], txs: [tx(a.id, 'topup', 100)] }), { userId: s.adminId });
  assert.equal(res.status, 'forced_release');
  assert.equal(await regStatus(s, p1), 'confirmed');
  assert.equal((await query('SELECT count(*)::int n FROM tavern_accounts WHERE id = $1', [a.id])).rows[0].n, 0);
  const list = await conflictsOf(s, 'forced_release');
  assert.equal(list.length, 3);
  const reg1 = list.find((c) => c.entity_id === p1);
  const reg2 = list.find((c) => c.entity_id === p2);
  const account = list.find((c) => c.entity_id === a.id);
  await resolveConflict(reg1.id, 'offline', s.adminId);
  await resolveConflict(reg2.id, 'online', s.adminId);
  await resolveConflict(account.id, 'offline', s.adminId);
  assert.equal(await regStatus(s, p1), 'checked_in');
  assert.equal(await regStatus(s, p2), 'confirmed');
  assert.equal((await query('SELECT balance_cents FROM tavern_accounts WHERE id = $1', [a.id])).rows[0].balance_cents, 100);
  assert.equal(await roleOf(s), 'primary');
});

test('forced_release: "ignored" closes without applying', async () => {
  const s = await scenario();
  const p = await addReg(s);
  await authority.forceRelease(s.eventId, s.adminId);
  await mergeReturnPackage(db, pkgOf(s, { registrations: [checkedIn(s, p)] }), { userId: s.adminId });
  const [c] = await conflictsOf(s, 'forced_release');
  await resolveConflict(c.id, 'ignored', s.adminId);
  assert.equal(await regStatus(s, p), 'confirmed');
});

test('unknown_entity: orphan ledger entries need an existing account to be applied', async () => {
  const s = await scenario();
  const orphanAccount = crypto.randomUUID();
  await mergeReturnPackage(db, pkgOf(s, { txs: [tx(orphanAccount, 'topup', 100)] }), { userId: s.adminId });
  const [c] = await conflictsOf(s, 'unknown_entity');
  await assert.rejects(resolveConflict(c.id, 'offline', s.adminId), { code: 'CANNOT_APPLY' });
  await resolveConflict(c.id, 'ignored', s.adminId);
  assert.equal((await query('SELECT status FROM sync_conflicts WHERE id = $1', [c.id])).rows[0].status, 'resolved');
});

test('clock_skew: nothing is merged; accepting the deviation allows the import', async () => {
  const s = await scenario();
  const p = await addReg(s);
  const pkg = pkgOf(s, { takenAt: new Date(Date.now() + 10 * 60_000), registrations: [checkedIn(s, p)] });
  const res = await mergeReturnPackage(db, pkg, { userId: s.adminId });
  assert.equal(res.status, 'clock_skew');
  assert.equal(await regStatus(s, p), 'confirmed');
  await mergeReturnPackage(db, pkg, { userId: s.adminId });
  const list = await conflictsOf(s, 'clock_skew');
  assert.equal(list.length, 1, 'no duplicate conflict for the same package');
  assert.equal((await mergeReturnPackage(db, pkgOf(s, { registrations: [checkedIn(s, p)] }), { userId: s.adminId, sentAt: new Date(Date.now() - 9 * 60_000) })).status, 'clock_skew');
  await resolveConflict(list[0].id, 'offline', s.adminId);
  const ok = await mergeReturnPackage(db, pkg, { userId: s.adminId });
  assert.equal(ok.status, 'released');
  assert.equal(await regStatus(s, p), 'checked_in');
});

test('rejects wrong snapshot id, older generation, undelegated event and retired snapshot', async () => {
  const s = await scenario();
  await assert.rejects(mergeReturnPackage(db, pkgOf(s, { snapshotId: crypto.randomUUID() }), {}), { code: 'WRONG_SNAPSHOT' });
  await assert.rejects(mergeReturnPackage(db, pkgOf(s, { generation: s.generation - 1 }), {}), { code: 'OUTDATED_GENERATION' });
  await mergeReturnPackage(db, pkgOf(s), { userId: s.adminId });
  await assert.rejects(mergeReturnPackage(db, pkgOf(s, { generation: s.generation + 5 }), {}), { code: 'SNAPSHOT_RETIRED' });
  await assert.rejects(mergeReturnPackage(db, pkgOf(s, { snapshotId: crypto.randomUUID() }), {}), { code: 'NOT_DELEGATED' });
});

test('interim sync twice in a row; online stays delegated, old packages are rejected, repeats are no-ops', async () => {
  const s = await scenario();
  const p = await addReg(s);
  const first = pkgOf(s, { registrations: [checkedIn(s, p)] });
  const r1 = await mergeReturnPackage(db, first, { userId: s.adminId, interim: true });
  assert.equal(r1.status, 'interim');
  let state = await authority.getState(s.eventId);
  assert.deepEqual([state.role, state.generation], ['delegated', s.generation + 1]);

  const out = { ...checkedIn(s, p), status: 'checked_out', checked_out_at: NOW() };
  const second = pkgOf(s, { generation: s.generation + 1, registrations: [out] });
  const r2 = await mergeReturnPackage(db, second, { userId: s.adminId, interim: true });
  assert.equal(r2.status, 'interim');
  assert.equal(await regStatus(s, p), 'checked_out');
  state = await authority.getState(s.eventId);
  assert.deepEqual([state.role, state.generation], ['delegated', s.generation + 2]);

  assert.equal((await mergeReturnPackage(db, first, {})).status, 'already_applied', 'the older package is not applied again (would undo the check-out)');
  assert.equal(await regStatus(s, p), 'checked_out');
  await assert.rejects(mergeReturnPackage(db, pkgOf(s, { generation: s.generation - 1 }), {}), { code: 'OUTDATED_GENERATION' });
  const fin = await mergeReturnPackage(db, pkgOf(s, { generation: s.generation + 2 }), { userId: s.adminId });
  assert.equal(fin.status, 'released');
  assert.equal((await query("SELECT count(*)::int n FROM snapshot_log WHERE snapshot_id = $1 AND result = 'interim'", [s.snapshotId])).rows[0].n, 2);
});

test('emergency release despite open conflicts keeps the conflicts and invalidates the snapshot', async () => {
  const s = await scenario();
  const p = await addReg(s, 'cancelled');
  await mergeReturnPackage(db, pkgOf(s, { registrations: [checkedIn(s, p)] }), { userId: s.adminId });
  assert.equal(await roleOf(s), 'delegated');
  const res = await emergencyRelease(s.eventId, s.adminId);
  assert.equal(res.openConflicts, 1);
  assert.equal(await roleOf(s), 'primary');
  assert.equal((await conflictsOf(s, 'registration_changed_online'))[0].status, 'open');
  assert.equal((await query("SELECT count(*)::int n FROM audit_log WHERE action = 'offline_force_release' AND details->>'eventId' = $1", [s.eventId])).rows[0].n, 1);
  // The leftover open conflict can still be resolved afterwards without touching the role.
  const [c] = await conflictsOf(s);
  assert.equal((await resolveConflict(c.id, 'offline', s.adminId)).released, false);
});
