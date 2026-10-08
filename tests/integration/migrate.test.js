import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
const { query, closePool } = await import('../../backend/db.js');

test('applies new migrations and skips already-applied ones', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
  await writeFile(
    path.join(dir, '001_create_widgets.sql'),
    'CREATE TABLE IF NOT EXISTS widgets (id serial primary key, name text)'
  );

  const first = await runMigrations({ migrationsDir: dir });
  assert.deepEqual(first, ['001_create_widgets.sql']);

  const second = await runMigrations({ migrationsDir: dir });
  assert.deepEqual(second, []);

  const { rows } = await query("SELECT to_regclass('widgets') AS exists");
  assert.ok(rows[0].exists);

  await query('DROP TABLE widgets');
  await query("DELETE FROM schema_migrations WHERE filename = '001_create_widgets.sql'");
  await rm(dir, { recursive: true, force: true });
});

test('warns about a migration that sorts before an already applied one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
  const names = ['901_ooo_later.sql', '900_ooo_earlier.sql'];
  await writeFile(path.join(dir, names[0]), 'SELECT 1');
  await runMigrations({ migrationsDir: dir });

  const warnings = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (String(chunk).includes('out-of-order migration')) warnings.push(String(chunk));
    return realWrite(chunk, ...rest);
  };
  try {
    await writeFile(path.join(dir, names[1]), 'SELECT 1');
    const applied = await runMigrations({ migrationsDir: dir });
    assert.deepEqual(applied, [names[1]]);
  } finally {
    process.stderr.write = realWrite;
    await query("DELETE FROM schema_migrations WHERE filename = ANY($1)", [names]);
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /900_ooo_earlier\.sql/);
});

test.after(async () => {
  await closePool();
});
