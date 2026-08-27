import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { NSC_PROFILE_SCHEMA_DEFAULTS } from '../config/nscProfileDefaults.js';

export async function seedNscProfileSchema() {
  const { rows } = await query('SELECT id FROM nsc_profile_schema LIMIT 1');
  if (rows.length > 0) {
    logger.info('nsc profile schema seed skipped: row already exists');
    return;
  }
  await query('INSERT INTO nsc_profile_schema (schema) VALUES ($1)', [JSON.stringify(NSC_PROFILE_SCHEMA_DEFAULTS)]);
  logger.info('nsc profile schema seeded');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  seedNscProfileSchema()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('nsc profile schema seed failed', { error: err.message });
      process.exit(1);
    });
}
