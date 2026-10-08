import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import pg from 'pg';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const BASE = (process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost:5433/pakyrion_test').replace(/\/[^/]*$/, '');
const SOURCE_URL = `${BASE}/pakyrion_test`;
const TARGET_NAME = `pakyrion_offimp_${crypto.randomBytes(4).toString('hex')}`;
const admin = new pg.Client({ connectionString: SOURCE_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${TARGET_NAME}`);
execFileSync(process.execPath, ['db/migrate.js'], { env: { ...process.env, DATABASE_URL: SOURCE_URL } });

const pool = new pg.Pool({ connectionString: SOURCE_URL });
const source = { query: (t, p) => pool.query(t, p) };
const { exportSnapshot } = await import('../../backend/offlinePackage/snapshot.js');
const dir = mkdtempSync(path.join(os.tmpdir(), 'offimp-'));

after(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE ${TARGET_NAME} WITH (FORCE)`);
  await admin.end();
  rmSync(dir, { recursive: true, force: true });
});

const run = (file, pass) => spawnSync(process.execPath, ['db/offlineImport.js', file], {
  env: { ...process.env, DATABASE_URL: `${BASE}/${TARGET_NAME}`, OFFLINE_PASSPHRASE: pass }, encoding: 'utf8',
});

test('offline:import CLI: error codes, success, refuses second import', async () => {
  const eventId = crypto.randomUUID();
  await source.query(`INSERT INTO events (id, name, event_date, is_active) VALUES ($1, 'CLI Con', '2027-09-01', true)`, [eventId]);
  await source.query(
    `INSERT INTO instance_authority (event_id, role, snapshot_id, snapshot_taken_at, delegated_at, generation) VALUES ($1, 'delegated', $2, now(), now(), 1)`,
    [eventId, crypto.randomUUID()]);
  const file = path.join(dir, 'snap.qpkg');
  writeFileSync(file, await exportSnapshot(source, eventId, 'pw'));

  let r = run(file, 'wrong');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BAD_PASSPHRASE/);

  r = run(file, 'pw');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Import erfolgreich/);

  r = run(file, 'pw');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ALREADY_OFFLINE/);
});
