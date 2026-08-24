import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from '../backend/db.js';
import { logger } from '../backend/logger.js';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

export async function runMigrations({ migrationsDir = DEFAULT_DIR } = {}) {
  await ensureMigrationsTable();

  const files = await readdir(migrationsDir)
    .then((entries) => entries.filter((f) => f.endsWith('.sql')).sort())
    .catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });

  const { rows } = await query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const newlyApplied = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    logger.info('applied migration', { file });
    newlyApplied.push(file);
  }
  return newlyApplied;
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
