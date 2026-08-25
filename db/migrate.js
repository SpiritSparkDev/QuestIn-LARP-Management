import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from '../backend/db.js';
import { logger } from '../backend/logger.js';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Arbitrary fixed key: serializes concurrent runMigrations() calls (e.g. multiple
// test files/processes starting up against the same fresh database at once) so
// they don't race each other creating the same tables.
const MIGRATION_LOCK_KEY = 7_390_215;

export async function runMigrations({ migrationsDir = DEFAULT_DIR } = {}) {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = await readdir(migrationsDir)
      .then((entries) => entries.filter((f) => f.endsWith('.sql')).sort())
      .catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      });

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    const newlyApplied = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      logger.info('applied migration', { file });
      newlyApplied.push(file);
    }
    return newlyApplied;
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runMigrations()
    .then((applied) => {
      logger.info('migrations complete', { count: applied.length });
      process.exit(0);
    })
    .catch((err) => {
      logger.error('migration failed', { error: err.message });
      process.exit(1);
    });
}
