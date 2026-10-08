import * as authority from '../instanceAuthority/repository.js';
import { seal, open, returnToken, fail } from './container.js';

// `db` is anything with query(text, params) and withTransaction(fn(client)),
// e.g. `import * as db from '../db.js'`.

const REG_COLUMNS = 'user_id, event_id, status, checked_in_at, checked_out_at, con_role, character_id, amount_due_cents, paid_at, flags, con_payer, created_at';
const GROUP_COLUMNS = 'key, name, visible_menus, account_fields, can_edit_characters, is_protected, can_override_checkin_status, can_export_members, can_export_sensitive, can_use_offline';
const TX_COLUMNS = 'id, account_id, type, amount_cents, method, note, items, reverses_id, voided_at, created_by, created_at';

async function schemaVersion(db) {
  const { rows } = await db.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1');
  return rows[0].filename;
}

async function instanceId(db) {
  await db.query('INSERT INTO instance_authority (event_id) VALUES (NULL) ON CONFLICT DO NOTHING');
  return (await db.query('SELECT instance_id FROM instance_authority WHERE event_id IS NULL')).rows[0].instance_id;
}

// Parser + verifier: decrypts, checks signature, package kind and schema version.
export async function readPackage(db, buffer, passphrase, kind) {
  const pkg = open(buffer, passphrase);
  if (pkg.manifest.kind !== kind) throw fail('WRONG_KIND', `Erwartet ${kind}-Paket, erhalten: ${pkg.manifest.kind}.`);
  const local = await schemaVersion(db);
  if (pkg.manifest.schema_version !== local) {
    throw fail('SCHEMA_MISMATCH', `App-Version passt nicht (Paket ${pkg.manifest.schema_version}, hier ${local}).`);
  }
  return pkg;
}

export async function exportSnapshot(db, eventId, passphrase) {
  const { rows: [state] } = await db.query(
    'SELECT role, snapshot_id, snapshot_taken_at, generation FROM instance_authority WHERE event_id = $1', [eventId]);
  if (state?.role !== 'delegated') throw fail('NOT_DELEGATED', 'Das Event ist nicht an eine Offline-Version delegiert.');

  const { rows: [event] } = await db.query('SELECT id, name, event_date, end_date, code, is_active FROM events WHERE id = $1', [eventId]);
  const { rows: groups } = await db.query(`SELECT ${GROUP_COLUMNS} FROM groups`);
  // Staff = may check in or use the tavern; only they get a real email and password hash.
  const { rows: userRows } = await db.query(
    `SELECT u.id, u.email, u.password_hash, u.first_name, u.last_name, u.nickname, g.key AS group_key,
            (g.key = 'admin' OR g.visible_menus ?| ARRAY['checkin', 'taverne']) AS staff
     FROM users u JOIN groups g ON g.id = u.group_id
     WHERE u.deactivated_at IS NULL
       AND (g.key = 'admin' OR g.visible_menus ?| ARRAY['checkin', 'taverne']
            OR u.id IN (SELECT user_id FROM registrations WHERE event_id = $1))`, [eventId]);
  const users = userRows.map(({ staff, ...u }) => (staff ? u : { ...u, email: `offline-${u.id}@offline.invalid`, password_hash: null }));
  const userIds = new Set(users.map((u) => u.id));

  const { rows: regs } = await db.query(`SELECT ${REG_COLUMNS} FROM registrations WHERE event_id = $1`, [eventId]);
  const { rows: chars } = await db.query(
    'SELECT id, user_id, name FROM characters WHERE id IN (SELECT character_id FROM registrations WHERE event_id = $1)', [eventId]);
  const characters = chars.filter((c) => userIds.has(c.user_id));
  const charIds = new Set(characters.map((c) => c.id));
  for (const r of regs) if (!charIds.has(r.character_id)) r.character_id = null;

  const { rows: items } = await db.query('SELECT id, name, category, price_cents, sort_order, active FROM tavern_items');
  const { rows: accounts } = await db.query(
    'SELECT id, event_id, number, user_id, label, balance_cents, locked, created_at FROM tavern_accounts WHERE event_id = $1', [eventId]);
  for (const a of accounts) if (!userIds.has(a.user_id)) a.user_id = null;
  const { rows: txs } = await db.query(
    `SELECT ${TX_COLUMNS} FROM tavern_transactions WHERE account_id IN (SELECT id FROM tavern_accounts WHERE event_id = $1) ORDER BY created_at, id`, [eventId]);
  for (const t of txs) if (!userIds.has(t.created_by)) t.created_by = null;
  const { rows: [settings] } = await db.query('SELECT tavern_enabled FROM app_settings LIMIT 1');

  const manifest = {
    kind: 'snapshot',
    snapshot_id: state.snapshot_id,
    taken_at: state.snapshot_taken_at,
    instance_id: await instanceId(db),
    schema_version: await schemaVersion(db),
    generation: state.generation,
    return_token: returnToken(state.snapshot_id),
    event_id: eventId,
  };
  const data = { event, groups, users, characters, registrations: regs, app_settings: settings, tavern_items: items, tavern_accounts: accounts, tavern_transactions: txs };
  return seal({ manifest, data }, passphrase);
}

const IDENT = /^[a-z_]+$/;

// Objects/arrays are JSON only for jsonb columns (text[] columns need real arrays).
async function jsonColumns(client, table) {
  const { rows } = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND data_type = 'jsonb'", [table]);
  return new Set(rows.map((r) => r.column_name));
}
const enc = (json, k, v) => (json.has(k) && v !== null ? JSON.stringify(v) : v);

async function insertRows(client, table, rows) {
  const json = await jsonColumns(client, table);
  for (const row of rows) {
    const keys = Object.keys(row);
    if (![table, ...keys].every((k) => IDENT.test(k))) throw fail('BAD_FORMAT', 'Ungültiger Spaltenname im Paket.');
    await client.query(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING`,
      keys.map((k) => enc(json, k, row[k])));
  }
}

// `authorityRepo` is injectable so the role switch can be stubbed.
export async function importSnapshot(db, buffer, passphrase, authorityRepo = authority) {
  const { manifest, data } = await readPackage(db, buffer, passphrase, 'snapshot');

  await db.withTransaction(async (client) => {
    const { rows: [n] } = await client.query('SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM events) AS n');
    if (Number(n.n) > 0) throw fail('NOT_EMPTY', 'Import nur in eine leere Datenbank möglich.');

    const groupIds = {};
    const groupJson = await jsonColumns(client, 'groups');
    for (const g of data.groups) {
      const keys = Object.keys(g).filter((k) => k !== 'key');
      const { rows } = await client.query(
        `INSERT INTO groups (key, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (key) DO UPDATE SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} RETURNING id`,
        [g.key, ...keys.map((k) => enc(groupJson, k, g[k]))]);
      groupIds[g.key] = rows[0].id;
    }
    await insertRows(client, 'events', [data.event]);
    await insertRows(client, 'users', data.users.map(({ group_key, ...u }) => ({ ...u, group_id: groupIds[group_key], email_verified: true })));
    await insertRows(client, 'characters', data.characters);
    await insertRows(client, 'registrations', data.registrations);
    await insertRows(client, 'tavern_items', data.tavern_items);
    await insertRows(client, 'tavern_accounts', data.tavern_accounts);
    await insertRows(client, 'tavern_transactions', data.tavern_transactions);
    if (data.app_settings) await client.query('UPDATE app_settings SET tavern_enabled = $1', [data.app_settings.tavern_enabled]);
  });

  // ponytail: separate transaction; a crash in between leaves data imported but the role unset (re-import needs a wiped DB).
  await authorityRepo.becomeOfflinePrimary(manifest.event_id, { snapshotId: manifest.snapshot_id, snapshotTakenAt: manifest.taken_at });
  await db.query('UPDATE instance_authority SET generation = $2 WHERE event_id = $1', [manifest.event_id, manifest.generation]);
  return { eventId: manifest.event_id, manifest };
}

// Offline domain only (see plan, point 3): check-in state, tavern ledger, audit entries since the snapshot.
// Does not retire the instance, so it also serves as an interim export.
export async function exportReturnPackage(db, passphrase) {
  const { rows: [state] } = await db.query(
    `SELECT event_id, snapshot_id, snapshot_taken_at, generation FROM instance_authority
     WHERE event_id IS NOT NULL AND role IN ('offline_primary', 'retired') LIMIT 1`);
  if (!state) throw fail('NOT_OFFLINE', 'Diese Instanz ist keine Offline-Version.');
  const q = (sql, p) => db.query(sql, p).then((r) => r.rows);
  const data = {
    registrations: await q('SELECT user_id, event_id, status, checked_in_at, checked_out_at FROM registrations WHERE event_id = $1', [state.event_id]),
    tavern_accounts: await q('SELECT id, event_id, number, user_id, label, balance_cents, locked, created_at FROM tavern_accounts WHERE event_id = $1', [state.event_id]),
    tavern_transactions: await q(
      `SELECT ${TX_COLUMNS} FROM tavern_transactions WHERE account_id IN (SELECT id FROM tavern_accounts WHERE event_id = $1) ORDER BY created_at, id`, [state.event_id]),
    audit_log: await q('SELECT id, created_at, actor_id, action, subject_user_id, details FROM audit_log WHERE created_at >= $1 ORDER BY created_at', [state.snapshot_taken_at]),
  };
  const manifest = {
    kind: 'return',
    snapshot_id: state.snapshot_id,
    taken_at: new Date(),
    instance_id: await instanceId(db),
    schema_version: await schemaVersion(db),
    generation: state.generation,
    return_token: returnToken(state.snapshot_id),
    event_id: state.event_id,
  };
  // Every export is a sync point: the next one carries a higher generation, so the
  // online side can tell a newer package from an already merged one.
  await db.query("UPDATE instance_authority SET generation = generation + 1 WHERE event_id = $1 AND role = 'offline_primary'", [state.event_id]);
  return seal({ manifest, data }, passphrase);
}
