import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const BASE = (process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost:5433/pakyrion_test').replace(/\/[^/]*$/, '');
const SOURCE_URL = `${BASE}/pakyrion_test`;
const TARGET_NAME = `pakyrion_offline_${crypto.randomBytes(4).toString('hex')}`;

// Target = fresh empty database behind the global db module (the "offline laptop");
// source = the shared test database, reached through its own pool (the "online" side).
const admin = new pg.Client({ connectionString: SOURCE_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${TARGET_NAME}`);
process.env.DATABASE_URL = `${BASE}/${TARGET_NAME}`;
execFileSync(process.execPath, ['db/migrate.js'], { env: { ...process.env, DATABASE_URL: SOURCE_URL } });

const target = await import('../../backend/db.js');
await (await import('../../db/migrate.js')).runMigrations();
const pool = new pg.Pool({ connectionString: SOURCE_URL });
const source = {
  query: (t, p) => pool.query(t, p),
  async withTransaction(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  },
};
const pkg = await import('../../backend/offlinePackage/snapshot.js');
const container = await import('../../backend/offlinePackage/container.js');

after(async () => {
  await target.closePool();
  await pool.end();
  await admin.query(`DROP DATABASE ${TARGET_NAME} WITH (FORCE)`);
  await admin.end();
});

const tag = crypto.randomBytes(3).toString('hex');
const ids = { event: crypto.randomUUID(), snapshot: crypto.randomUUID() };
const takenAt = new Date('2027-08-30T10:00:00Z');
let helper, player, account;

async function seedSource() {
  const q = source.query;
  const staffGroup = (await q(
    `INSERT INTO groups (key, name, visible_menus, account_fields) VALUES ($1, 'Helfer', '["checkin"]', '[]') RETURNING id`, [`off_helper_${tag}`])).rows[0].id;
  const playerGroup = (await q(
    `INSERT INTO groups (key, name, visible_menus, account_fields) VALUES ($1, 'Spieler', '["konto"]', '[]') RETURNING id`, [`off_player_${tag}`])).rows[0].id;
  await q(`INSERT INTO events (id, name, event_date, is_active) VALUES ($1, 'Offline Con', '2027-09-01', true)`, [ids.event]);
  helper = (await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, group_id, email_verified) VALUES ($1, 'HASH', 'Hel', 'Fer', $2, true) RETURNING id`,
    [`helper-${tag}@example.com`, staffGroup])).rows[0].id;
  player = (await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, group_id, email_verified, emergency_contact_legacy_enc, account_data_enc) VALUES ($1, 'PLAYERHASH', 'Spie', 'Ler', $2, true, $3, $3) RETURNING id`,
    [`player-${tag}@example.com`, playerGroup, Buffer.from('SECRETMED')])).rows[0].id;
  const charId = (await q(`INSERT INTO characters (user_id, name) VALUES ($1, 'Grimbold') RETURNING id`, [player])).rows[0].id;
  await q(`INSERT INTO registrations (user_id, event_id, status, character_id, amount_due_cents, paid_at) VALUES ($1, $2, 'confirmed', $3, 5000, now())`, [player, ids.event, charId]);
  await q(`INSERT INTO tavern_items (name, price_cents) VALUES ('Met', 300)`);
  account = (await q(`INSERT INTO tavern_accounts (event_id, number, user_id, balance_cents) VALUES ($1, 1, $2, 700) RETURNING id`, [ids.event, player])).rows[0].id;
  await q(`INSERT INTO tavern_transactions (account_id, type, amount_cents, created_by) VALUES ($1, 'topup', 1000, $2), ($1, 'charge', -300, $2)`, [account, helper]);
  await q(
    `INSERT INTO instance_authority (event_id, role, snapshot_id, snapshot_taken_at, delegated_at, generation) VALUES ($1, 'delegated', $2, $3, $3, 1)`,
    [ids.event, ids.snapshot, takenAt]);
}
await seedSource();

test('container: round trip, wrong passphrase, tampering', () => {
  const buf = container.seal({ manifest: { a: 1 }, data: { b: 2 } }, 'pw');
  assert.deepEqual(container.open(buf, 'pw'), { manifest: { a: 1 }, data: { b: 2 } });
  assert.throws(() => container.open(buf, 'other'), { code: 'BAD_PASSPHRASE' });
  assert.throws(() => container.open(Buffer.from('garbage'), 'pw'), { code: 'BAD_FORMAT' });
  const tampered = Buffer.from(buf);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => container.open(tampered, 'pw'), { code: 'BAD_PASSPHRASE' });
});

test('container: package signed with another key is rejected', () => {
  const buf = container.seal({ manifest: { a: 1 }, data: {} }, 'pw');
  const saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'b'.repeat(64);
  try { assert.throws(() => container.open(buf, 'pw'), { code: 'BAD_SIGNATURE' }); }
  finally { process.env.ENCRYPTION_KEY = saved; }
});

test('exportSnapshot: refuses an event that is not delegated', async () => {
  const other = (await source.query(`INSERT INTO events (name, event_date) VALUES ('Nope', '2027-09-02') RETURNING id`)).rows[0].id;
  await assert.rejects(pkg.exportSnapshot(source, other, 'pw'), { code: 'NOT_DELEGATED' });
});

let snapshotBuffer;

test('exportSnapshot: reduced data, manifest, no sensitive fields', async () => {
  snapshotBuffer = await pkg.exportSnapshot(source, ids.event, 'pw');
  const { manifest, data } = container.open(snapshotBuffer, 'pw');
  assert.equal(manifest.snapshot_id, ids.snapshot);
  assert.equal(new Date(manifest.taken_at).getTime(), takenAt.getTime());
  assert.equal(manifest.generation, 1);
  assert.match(manifest.schema_version, /^\d{3}_.*\.sql$/);
  assert.ok(manifest.instance_id && manifest.return_token);
  const json = JSON.stringify(data);
  assert.ok(!json.includes('SECRETMED'));
  assert.ok(!json.includes('PLAYERHASH'), 'participant password hash must not be included');
  assert.ok(json.includes('HASH') && json.includes(`helper-${tag}@example.com`), 'staff login is included');
  assert.ok(!json.includes(`player-${tag}@example.com`), 'participant email must not be included');
  assert.ok(json.includes('Grimbold') && json.includes('Spie'));
  assert.equal(data.tavern_transactions.length, 2);
});

test('importSnapshot: wrong passphrase, schema mismatch', async () => {
  await assert.rejects(pkg.importSnapshot(target, snapshotBuffer, 'wrong'), { code: 'BAD_PASSPHRASE' });
  await target.query("INSERT INTO schema_migrations (filename) VALUES ('999_future.sql')");
  try { await assert.rejects(pkg.importSnapshot(target, snapshotBuffer, 'pw'), { code: 'SCHEMA_MISMATCH' }); }
  finally { await target.query("DELETE FROM schema_migrations WHERE filename = '999_future.sql'"); }
  const { rows } = await target.query('SELECT count(*)::int n FROM users');
  assert.equal(rows[0].n, 0, 'failed import leaves the database untouched');
});

test('importSnapshot: fills the empty database and becomes offline_primary', async () => {
  const res = await pkg.importSnapshot(target, snapshotBuffer, 'pw');
  assert.equal(res.eventId, ids.event);
  const { rows: auth } = await target.query('SELECT role, snapshot_id, generation FROM instance_authority WHERE event_id = $1', [ids.event]);
  assert.deepEqual(auth[0], { role: 'offline_primary', snapshot_id: ids.snapshot, generation: 1 });
  // the shared source DB holds other staff users too, so look at ours only
  const { rows: users } = await target.query('SELECT email, password_hash FROM users WHERE id = ANY($1)', [[helper, player]]);
  assert.equal(users.length, 2);
  assert.equal(users.find((u) => u.email === `helper-${tag}@example.com`).password_hash, 'HASH');
  assert.equal(users.find((u) => u.email !== `helper-${tag}@example.com`).password_hash, null);
  const { rows: tx } = await target.query('SELECT count(*)::int n FROM tavern_transactions WHERE account_id = $1', [account]);
  assert.equal(tx[0].n, 2);
  const { rows: reg } = await target.query('SELECT status, paid_at FROM registrations WHERE user_id = $1', [player]);
  assert.equal(reg[0].status, 'confirmed');
  assert.ok(reg[0].paid_at);
});

test('importSnapshot: refuses a non-empty database', async () => {
  await assert.rejects(pkg.importSnapshot(target, snapshotBuffer, 'pw'), { code: 'NOT_EMPTY' });
});

test('exportReturnPackage: only the offline domain, signed with the same token', async () => {
  await target.query("UPDATE registrations SET status = 'checked_in', checked_in_at = now()");
  await target.query('UPDATE tavern_accounts SET balance_cents = 400');
  await target.query("INSERT INTO tavern_transactions (account_id, type, amount_cents) SELECT id, 'charge', -300 FROM tavern_accounts");
  const buf = await pkg.exportReturnPackage(target, 'rp');
  const { manifest, data } = await pkg.readPackage(source, buf, 'rp', 'return');
  assert.equal(manifest.snapshot_id, ids.snapshot);
  assert.equal(manifest.generation, 1);
  assert.equal(manifest.return_token, container.returnToken(ids.snapshot));
  assert.deepEqual(Object.keys(data).sort(), ['audit_log', 'registrations', 'tavern_accounts', 'tavern_transactions']);
  assert.equal(data.registrations[0].status, 'checked_in');
  assert.equal(data.tavern_transactions.length, 3);
  await assert.rejects(pkg.readPackage(source, buf, 'rp', 'snapshot'), { code: 'WRONG_KIND' });
});
