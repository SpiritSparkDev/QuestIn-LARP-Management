import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

const baseUrl = new URL(process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test');
const hasPgTools = spawnSync('pg_dump', ['--version']).status === 0
  && spawnSync('pg_restore', ['--version']).status === 0;
const skip = hasPgTools ? false : 'pg_dump/pg_restore not installed';

const SRC = 'backup_script_src';
const DST = 'backup_script_dst';

function urlFor(db) {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

function pgEnv(db) {
  return {
    ...process.env,
    PGHOST: baseUrl.hostname,
    PGPORT: baseUrl.port || '5432',
    PGUSER: decodeURIComponent(baseUrl.username),
    PGPASSWORD: decodeURIComponent(baseUrl.password),
    PGDATABASE: db,
  };
}

function sh(script, args, env) {
  return spawnSync('sh', [path.resolve('ops', script), ...args], { env, encoding: 'utf8' });
}

async function recreate(db) {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
}

test('backup.sh dumps db and uploads, restore.sh brings them back', { skip }, async () => {
  await recreate(SRC);
  await recreate(DST);
  const src = new pg.Client({ connectionString: urlFor(SRC) });
  await src.connect();
  await src.query('CREATE TABLE people (name text)');
  await src.query("INSERT INTO people VALUES ('Aria'), ('Borin')");
  await src.end();

  const work = mkdtempSync(path.join(tmpdir(), 'backup-test-'));
  try {
    const uploads = path.join(work, 'uploads');
    mkdirSync(uploads);
    writeFileSync(path.join(uploads, 'portrait.txt'), 'hello');
    const backups = path.join(work, 'backups');

    const run = sh('backup.sh', [], { ...pgEnv(SRC), BACKUP_DIR: backups, UPLOADS_DIR: uploads });
    assert.equal(run.status, 0, run.stderr);
    const files = readdirSync(backups);
    const dump = files.find((f) => f.startsWith('db-') && f.endsWith('.dump'));
    const archive = files.find((f) => f.startsWith('uploads-') && f.endsWith('.tar.gz'));
    assert.ok(dump && archive, files.join(', '));
    assert.ok(files.includes(`${dump}.sha256`));

    const restoredUploads = path.join(work, 'restored');
    const restore = sh(
      'restore.sh',
      ['--yes', path.join(backups, dump), path.join(backups, archive)],
      { ...pgEnv(DST), UPLOADS_DIR: restoredUploads },
    );
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(readFileSync(path.join(restoredUploads, 'portrait.txt'), 'utf8'), 'hello');

    const dst = new pg.Client({ connectionString: urlFor(DST) });
    await dst.connect();
    const { rows } = await dst.query('SELECT name FROM people ORDER BY name');
    await dst.end();
    assert.deepEqual(rows.map((r) => r.name), ['Aria', 'Borin']);

    // A damaged dump is refused before anything is restored.
    writeFileSync(path.join(backups, dump), 'tampered', { flag: 'a' });
    const bad = sh('restore.sh', ['--yes', path.join(backups, dump)], pgEnv(DST));
    assert.notEqual(bad.status, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('backup.sh fails loudly when the database is unreachable', { skip }, () => {
  const work = mkdtempSync(path.join(tmpdir(), 'backup-test-'));
  try {
    const run = sh('backup.sh', [], { ...pgEnv('backup_script_missing'), BACKUP_DIR: work });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /FAILED/);
    assert.equal(readdirSync(work).filter((f) => f.startsWith('db-')).length, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('backup.sh rotation keeps recent days plus weekly and monthly sets', { skip }, async () => {
  await recreate(SRC);
  const work = mkdtempSync(path.join(tmpdir(), 'backup-test-'));
  try {
    for (let i = 1; i <= 120; i += 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      writeFileSync(path.join(work, `db-${d}-030000.dump`), '');
      writeFileSync(path.join(work, `db-${d}-030000.dump.sha256`), '');
    }
    const run = sh('backup.sh', [], { ...pgEnv(SRC), BACKUP_DIR: work });
    assert.equal(run.status, 0, run.stderr);
    const sets = readdirSync(work).filter((f) => f.endsWith('.dump'));
    // 7 days (incl. today) + up to 4 weeks + up to 6 months, overlapping, never all 120.
    assert.ok(sets.length >= 8 && sets.length <= 17, `kept ${sets.length}`);
    assert.ok(readdirSync(work).some((f) => f.includes(new Date().toISOString().slice(0, 10))));
    assert.equal(readdirSync(work).filter((f) => f.endsWith('.dump.sha256')).length, sets.length);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
