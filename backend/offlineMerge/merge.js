import * as defaultDb from '../db.js';
import * as authority from '../instanceAuthority/repository.js';
import { fail } from '../offlinePackage/container.js';
import { readPackage } from '../offlinePackage/snapshot.js';
import { logAudit } from '../audit/repository.js';

// Return merge (plan step 4). `db` is anything with query() and withTransaction(fn(client)).
// Conflict-free parts are applied idempotently; everything else becomes a sync_conflicts row
// whose offline_value is a "fragment" that resolveConflict can apply later.
// ponytail: role switches and audit go through the global db (like importSnapshot's authorityRepo); only the merge itself uses `db`.

const SKEW_MS = 5 * 60_000;
const COUNTED = ['pending', 'confirmed', 'checked_in', 'checked_out'];

// What an admin may choose per conflict type (see plan table).
export const ALLOWED = {
  registration_changed_online: ['offline', 'online', 'ignored'],
  account_deleted_online: ['offline', 'online', 'ignored'],
  tavern_number_collision: ['offline', 'ignored'], // offline = confirm the renumbering
  balance_mismatch: ['offline', 'merged', 'online', 'ignored'], // merged = balance recomputed from the ledger
  duplicate_walkin: ['offline', 'merged', 'ignored'], // merged = fold into one account
  forced_release: ['offline', 'online', 'ignored'],
  unknown_entity: ['offline', 'online', 'ignored'],
  clock_skew: ['offline', 'online', 'ignored'], // offline = accept the deviation, then re-import
};

const iso = (v) => (v ? new Date(v).toISOString() : null);
const sameCheckin = (a, b) => a.status === b.status && iso(a.checked_in_at) === iso(b.checked_in_at) && iso(a.checked_out_at) === iso(b.checked_out_at);
const touched = (r) => r.checked_in_at || r.checked_out_at || r.status === 'checked_in' || r.status === 'checked_out';
const sumOf = (txs) => txs.reduce((s, t) => s + t.amount_cents, 0);
const group = (rows, key) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) ?? []), r]), new Map());
const checkinOf = (r) => ({ kind: 'registration', user_id: r.user_id, event_id: r.event_id, status: r.status, checked_in_at: r.checked_in_at, checked_out_at: r.checked_out_at });

async function knownUsers(client, ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Set();
  const { rows } = await client.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [wanted]);
  return new Set(rows.map((r) => r.id));
}

async function applyRegistration(client, r) {
  const { rowCount } = await client.query(
    'UPDATE registrations SET status = $3, checked_in_at = $4, checked_out_at = $5 WHERE user_id = $1 AND event_id = $2',
    [r.user_id, r.event_id, r.status, r.checked_in_at, r.checked_out_at]);
  if (rowCount) return;
  if (!(await knownUsers(client, [r.user_id])).has(r.user_id)) throw fail('CANNOT_APPLY', 'Der Benutzer existiert online nicht (mehr).');
  await client.query('INSERT INTO registrations (user_id, event_id, status, checked_in_at, checked_out_at) VALUES ($1, $2, $3, $4, $5)',
    [r.user_id, r.event_id, r.status, r.checked_in_at, r.checked_out_at]);
}

async function applyTransactions(client, txs, known) {
  let added = 0;
  for (const t of txs) {
    const ins = await client.query(
      `INSERT INTO tavern_transactions (id, account_id, type, amount_cents, method, note, items, reverses_id, voided_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      [t.id, t.account_id, t.type, t.amount_cents, t.method, t.note, t.items === null ? null : JSON.stringify(t.items), t.reverses_id, t.voided_at,
        known.has(t.created_by) ? t.created_by : null, t.created_at]);
    added += ins.rowCount;
    if (t.voided_at) await client.query('UPDATE tavern_transactions SET voided_at = $2 WHERE id = $1 AND voided_at IS NULL', [t.id, t.voided_at]);
  }
  return added;
}

// Insert-or-update one account plus its ledger. Ledger rows are idempotent by id.
async function applyAccount(client, a, txs, known, { number = a.number, balance = a.balance_cents } = {}) {
  const { rows: [r] } = await client.query(
    `INSERT INTO tavern_accounts (id, event_id, number, user_id, label, balance_cents, locked, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET balance_cents = EXCLUDED.balance_cents, locked = EXCLUDED.locked, label = EXCLUDED.label
     RETURNING (xmax = 0) AS inserted`,
    [a.id, a.event_id, number, known.has(a.user_id) ? a.user_id : null, a.label, balance, a.locked, a.created_at]);
  return { inserted: r.inserted, added: await applyTransactions(client, txs, known) };
}

async function nextNumber(client, eventId) {
  return (await client.query('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tavern_accounts WHERE event_id = $1', [eventId])).rows[0].n;
}

const accountFragment = (account, transactions) => ({ kind: 'account', account, transactions });

export async function mergeReturnPackage(db, pkg, { userId = null, interim = false, via = 'file', sentAt = null } = {}, authorityRepo = authority) {
  const m = pkg.manifest;
  const data = pkg.data;
  const eventId = m.event_id;

  const result = await db.withTransaction(async (client) => {
    const q = (sql, p) => client.query(sql, p).then((r) => r.rows);
    const [state] = await q('SELECT role, snapshot_id, snapshot_taken_at, generation FROM instance_authority WHERE event_id = $1 FOR UPDATE', [eventId]);

    const [done] = await q('SELECT report FROM offline_merges WHERE snapshot_id = $1 AND generation = $2', [m.snapshot_id, m.generation]);
    if (done) return { status: 'already_applied', alreadyApplied: true, report: done.report, conflicts: [] };

    const normal = state?.role === 'delegated' && state.snapshot_id === m.snapshot_id;
    if (!normal) {
      const logged = new Set((await q('SELECT result FROM snapshot_log WHERE snapshot_id = $1', [m.snapshot_id])).map((r) => r.result));
      if (!logged.has('forced')) {
        if (logged.has('returned')) throw fail('SNAPSHOT_RETIRED', 'Dieser Snapshot wurde bereits zurückgegeben; weitere Pakete werden abgelehnt.');
        if (state?.role === 'delegated') throw fail('WRONG_SNAPSHOT', 'Das Paket gehört zu einem anderen Snapshot als die aktuelle Delegation.');
        throw fail('NOT_DELEGATED', 'Das Event ist nicht an eine Offline-Version delegiert.');
      }
    } else if (m.generation < state.generation) {
      throw fail('OUTDATED_GENERATION', `Paket ist veraltet (Generation ${m.generation}, aktuell ${state.generation}).`);
    }

    // Clock deviation: whole package is held back until an admin accepts it.
    const now = Date.now();
    const takenAt = new Date(m.taken_at).getTime();
    const skewed = (sentAt && Math.abs(new Date(sentAt).getTime() - now) > SKEW_MS)
      || takenAt > now + SKEW_MS
      || (normal && takenAt < new Date(state.snapshot_taken_at).getTime() - SKEW_MS)
      || data.tavern_transactions.some((t) => new Date(t.created_at).getTime() > takenAt + SKEW_MS);
    if (skewed) {
      const [accepted] = await q("SELECT 1 FROM sync_conflicts WHERE type = 'clock_skew' AND snapshot_id = $1 AND generation = $2 AND resolution = 'offline'", [m.snapshot_id, m.generation]);
      if (!accepted) {
        let [c] = await q("SELECT id, type, entity, entity_id FROM sync_conflicts WHERE type = 'clock_skew' AND snapshot_id = $1 AND generation = $2 AND status = 'open'", [m.snapshot_id, m.generation]);
        c ??= (await q(
          `INSERT INTO sync_conflicts (snapshot_id, generation, type, entity, offline_value, online_value) VALUES ($1, $2, 'clock_skew', 'package', $3, $4) RETURNING id, type, entity, entity_id`,
          [m.snapshot_id, m.generation, JSON.stringify({ kind: 'clock', packageTakenAt: m.taken_at, sentAt }), JSON.stringify({ now: new Date(now).toISOString() })]))[0];
        return { status: 'clock_skew', conflicts: [c], report: null };
      }
    }

    const report = { checkIns: 0, checkOuts: 0, newAccounts: 0, updatedAccounts: 0, newTransactions: 0, balanceSumCents: 0, auditEntries: 0, conflicts: 0 };
    const found = [];
    const flag = (type, entity, entityId, offline, online = null) => found.push({ type, entity, entityId, offline, online });

    const onlineRegs = new Map((await q('SELECT user_id, status, checked_in_at, checked_out_at FROM registrations WHERE event_id = $1', [eventId])).map((r) => [r.user_id, r]));
    const onlineAccs = new Map((await q('SELECT id, number, user_id, label, balance_cents, locked FROM tavern_accounts WHERE event_id = $1', [eventId])).map((r) => [r.id, r]));
    const txsByAccount = group(data.tavern_transactions, 'account_id');

    if (!normal) {
      // Forced release: nothing is taken over automatically, every touched record is a single review item.
      for (const r of data.registrations.filter(touched)) {
        const o = onlineRegs.get(r.user_id);
        if (!o || !sameCheckin(o, r)) flag('forced_release', 'registration', r.user_id, checkinOf(r), o ?? null);
      }
      for (const a of data.tavern_accounts) {
        const txs = txsByAccount.get(a.id) ?? [];
        const o = onlineAccs.get(a.id);
        if (!o || o.balance_cents !== a.balance_cents || o.locked !== a.locked) flag('forced_release', 'tavern_account', a.id, accountFragment(a, txs), o ?? null);
      }
    } else {
      for (const r of data.registrations.filter(touched)) {
        const o = onlineRegs.get(r.user_id);
        if (!o) flag('unknown_entity', 'registration', r.user_id, checkinOf(r));
        else if (sameCheckin(o, r)) continue;
        else if (!COUNTED.includes(o.status)) flag('registration_changed_online', 'registration', r.user_id, checkinOf(r), o);
        else {
          await applyRegistration(client, r);
          if (r.checked_in_at) report.checkIns++;
          if (r.checked_out_at) report.checkOuts++;
        }
      }

      const known = await knownUsers(client, [...data.tavern_accounts.map((a) => a.user_id), ...data.tavern_transactions.map((t) => t.created_by)]);
      const taken = new Map([...onlineAccs.values()].map((a) => [a.number, a]));
      let maxNumber = Math.max(0, ...taken.keys(), ...data.tavern_accounts.map((a) => a.number));
      const addedNew = [];
      for (const a of data.tavern_accounts) {
        const txs = txsByAccount.get(a.id) ?? [];
        const o = onlineAccs.get(a.id);
        const sum = sumOf(txs);
        if (sum !== a.balance_cents) {
          flag('balance_mismatch', 'tavern_account', a.id, { ...accountFragment(a, txs), sumCents: sum }, o ?? null);
          continue;
        }
        if (a.user_id && (!known.has(a.user_id) || (o && o.user_id === null))) {
          flag('account_deleted_online', 'tavern_account', a.id, accountFragment(a, txs), o ?? null);
          continue;
        }
        let number = a.number;
        if (!o && taken.has(number)) {
          number = ++maxNumber;
          const holder = taken.get(a.number);
          flag('tavern_number_collision', 'tavern_account', a.id, { kind: 'renumbered', originalNumber: a.number, newNumber: number, label: a.label }, { number: a.number, accountId: holder.id, label: holder.label });
        }
        const res = await applyAccount(client, a, txs, known, { number });
        if (res.inserted) { report.newAccounts++; if (!a.user_id) addedNew.push({ ...a, number }); } else report.updatedAccounts++;
        report.newTransactions += res.added;
        report.balanceSumCents += a.balance_cents;
      }
      for (const [accountId, txs] of txsByAccount) {
        if (!data.tavern_accounts.some((a) => a.id === accountId)) flag('unknown_entity', 'tavern_transaction', accountId, { kind: 'transactions', accountId, transactions: txs });
      }
      const byName = new Map();
      for (const a of addedNew.filter((x) => x.label?.trim())) byName.set(a.label.trim().toLowerCase(), [...(byName.get(a.label.trim().toLowerCase()) ?? []), a]);
      for (const [label, list] of byName) {
        if (list.length > 1) flag('duplicate_walkin', 'tavern_account', list[0].id, { kind: 'duplicate', label, accounts: list.map((a) => ({ id: a.id, number: a.number, balanceCents: a.balance_cents })) });
      }

      const auditKnown = await knownUsers(client, data.audit_log.flatMap((e) => [e.actor_id, e.subject_user_id]));
      for (const e of data.audit_log) {
        const ins = await client.query(
          `INSERT INTO audit_log (id, created_at, actor_id, action, subject_user_id, details) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
          [e.id, e.created_at, auditKnown.has(e.actor_id) ? e.actor_id : null, e.action, auditKnown.has(e.subject_user_id) ? e.subject_user_id : null, JSON.stringify(e.details ?? {})]);
        report.auditEntries += ins.rowCount;
      }
    }

    const conflicts = [];
    for (const c of found) {
      const [row] = await q(
        `INSERT INTO sync_conflicts (snapshot_id, generation, type, entity, entity_id, offline_value, online_value) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, type, entity, entity_id`,
        [m.snapshot_id, m.generation, c.type, c.entity, c.entityId, JSON.stringify(c.offline), c.online === null ? null : JSON.stringify(c.online)]);
      conflicts.push(row);
      report.conflicts++;
    }

    const mode = !normal ? 'forced' : interim ? 'interim' : 'final';
    await client.query(
      `INSERT INTO offline_merges (snapshot_id, event_id, generation, mode, via_token, pending_release, report, merged_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [m.snapshot_id, eventId, m.generation, mode, via === 'token', mode === 'final' && conflicts.length > 0, JSON.stringify(report), userId]);
    if (normal) {
      await client.query('UPDATE instance_authority SET generation = $2 WHERE event_id = $1', [eventId, Math.max(state.generation, m.generation) + 1]);
      if (interim) {
        await client.query("INSERT INTO snapshot_log (event_id, snapshot_id, generation, created_by, result) VALUES ($1, $2, $3, $4, 'interim')",
          [eventId, m.snapshot_id, m.generation, userId]);
      }
    }
    const status = !normal ? 'forced_release' : conflicts.length ? 'conflicts' : interim ? 'interim' : 'merged';
    return { status, report, conflicts, normal };
  });

  if (result.status === 'merged') {
    // ponytail: separate transaction; if it fails the merge stays applied and an admin uses the release route.
    await authorityRepo.returnToPrimary(eventId, userId);
    result.status = 'released';
  }
  if (!result.alreadyApplied && result.status !== 'clock_skew') {
    await logAudit({ actorId: userId, action: 'offline_return', details: { eventId, snapshotId: m.snapshot_id, generation: m.generation, via, status: result.status, report: result.report } });
  }
  return result;
}

// Decrypt + verify (signature, passphrase, kind, schema) and merge.
export async function mergeReturnBuffer(db, buffer, passphrase, opts, authorityRepo) {
  return mergeReturnPackage(db, await readPackage(db, buffer, passphrase, 'return'), opts, authorityRepo);
}

async function applyResolution(client, c, resolution) {
  const f = c.offline_value;
  if (f.kind === 'registration') return applyRegistration(client, f);
  if (f.kind === 'account') {
    const a = f.account;
    const known = await knownUsers(client, [a.user_id, ...f.transactions.map((t) => t.created_by)]);
    const { rows: [clash] } = await client.query('SELECT id FROM tavern_accounts WHERE event_id = $1 AND number = $2 AND id <> $3', [a.event_id, a.number, a.id]);
    return applyAccount(client, a, f.transactions, known, {
      number: clash ? await nextNumber(client, a.event_id) : a.number,
      balance: resolution === 'merged' ? sumOf(f.transactions) : a.balance_cents,
    });
  }
  if (f.kind === 'transactions') {
    const { rowCount } = await client.query('SELECT 1 FROM tavern_accounts WHERE id = $1', [f.accountId]);
    if (!rowCount) throw fail('CANNOT_APPLY', 'Das Konto existiert online nicht; die Buchungen können nicht übernommen werden.');
    return applyTransactions(client, f.transactions, await knownUsers(client, f.transactions.map((t) => t.created_by)));
  }
  if (f.kind === 'duplicate' && resolution === 'merged') {
    const [keep, ...rest] = f.accounts.map((a) => a.id);
    const { rows } = await client.query('SELECT id FROM tavern_accounts WHERE id = ANY($1::uuid[])', [[keep, ...rest]]);
    if (rows.length !== f.accounts.length) throw fail('CANNOT_APPLY', 'Eines der Konten existiert nicht mehr.');
    await client.query('UPDATE tavern_transactions SET account_id = $1 WHERE account_id = ANY($2::uuid[])', [keep, rest]);
    await client.query('UPDATE tavern_accounts SET balance_cents = (SELECT COALESCE(SUM(amount_cents), 0) FROM tavern_transactions WHERE account_id = $1) WHERE id = $1', [keep]);
    await client.query('DELETE FROM tavern_accounts WHERE id = ANY($1::uuid[])', [rest]);
  }
  // renumbered / clock / duplicate kept: confirmation only
}

export async function resolveConflict(id, resolution, userId, note = null, db = defaultDb, authorityRepo = authority) {
  const out = await db.withTransaction(async (client) => {
    const { rows: [c] } = await client.query('SELECT * FROM sync_conflicts WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw fail('CONFLICT_NOT_FOUND', 'Konflikt nicht gefunden.');
    if (c.status !== 'open') throw fail('ALREADY_RESOLVED', 'Der Konflikt ist bereits gelöst.');
    if (!ALLOWED[c.type]?.includes(resolution)) throw fail('INVALID_RESOLUTION', `Auflösung "${resolution}" ist für ${c.type} nicht möglich.`);
    if (resolution === 'offline' || resolution === 'merged') await applyResolution(client, c, resolution);
    const { rows: [updated] } = await client.query(
      `UPDATE sync_conflicts SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now(), note = $4 WHERE id = $1 RETURNING *`,
      [id, resolution, userId, note]);
    const { rows: [left] } = await client.query("SELECT count(*)::int AS n FROM sync_conflicts WHERE snapshot_id = $1 AND status = 'open'", [c.snapshot_id]);
    const { rows: [pending] } = await client.query('SELECT id, event_id FROM offline_merges WHERE snapshot_id = $1 AND pending_release', [c.snapshot_id]);
    return { before: c, conflict: updated, release: left.n === 0 ? pending : null };
  });
  let released = false;
  if (out.release) {
    const state = await authorityRepo.getState(out.release.event_id);
    if (state.role === 'delegated' && state.snapshotId === out.before.snapshot_id) {
      await authorityRepo.returnToPrimary(out.release.event_id, userId);
      released = true;
    }
    await db.query('UPDATE offline_merges SET pending_release = false WHERE id = $1', [out.release.id]);
  }
  await logAudit({
    actorId: userId, action: 'sync_conflict_resolved',
    details: {
      conflictId: id, type: out.before.type, entity: out.before.entity, entityId: out.before.entity_id, resolution, note,
      before: { status: 'open', offlineValue: out.before.offline_value, onlineValue: out.before.online_value }, after: { status: 'resolved', resolution }, released,
    },
  });
  return { conflict: out.conflict, released };
}

// Admin takes the event back although conflicts are open (or the delegation is simply abandoned).
export async function emergencyRelease(eventId, userId, db = defaultDb, authorityRepo = authority) {
  const state = await authorityRepo.getState(eventId);
  const { rows: [n] } = await db.query(
    "SELECT count(*)::int AS n FROM sync_conflicts WHERE status = 'open' AND snapshot_id = $1", [state.snapshotId]);
  await authorityRepo.forceRelease(eventId, userId);
  await db.query('UPDATE offline_merges SET pending_release = false WHERE snapshot_id = $1', [state.snapshotId]);
  await logAudit({ actorId: userId, action: 'offline_force_release', details: { eventId, snapshotId: state.snapshotId, openConflicts: n.n } });
  return { openConflicts: n.n };
}

export async function listConflicts({ status, type } = {}, db = defaultDb) {
  const { rows } = await db.query(
    `SELECT * FROM sync_conflicts WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR type = $2) ORDER BY created_at DESC, id`,
    [status ?? null, type ?? null]);
  return rows.map((r) => ({
    id: r.id, snapshotId: r.snapshot_id, generation: r.generation, type: r.type, entity: r.entity, entityId: r.entity_id,
    offlineValue: r.offline_value, onlineValue: r.online_value, status: r.status, resolution: r.resolution,
    resolvedBy: r.resolved_by, resolvedAt: r.resolved_at, note: r.note, createdAt: r.created_at,
    allowedResolutions: r.status === 'open' ? ALLOWED[r.type] ?? [] : [],
  }));
}
