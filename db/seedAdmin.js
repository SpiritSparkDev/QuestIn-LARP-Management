import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../backend/db.js';
import { hashPassword } from '../backend/crypto/password.js';
import { logger } from '../backend/logger.js';

// Idempotent bootstrap: if ADMINUSER/ADMINPASS are set and no user with that
// email exists yet, create a verified admin account for it. Safe to run on
// every deploy/restart — a no-op once the account exists.
export async function seedAdmin() {
  const email = process.env.ADMINUSER;
  const password = process.env.ADMINPASS;
  if (!email || !password) {
    logger.info('admin seed skipped: ADMINUSER/ADMINPASS not set');
    return null;
  }

  const normalizedEmail = email.toLowerCase();
  const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing.length > 0) {
    logger.info('admin seed skipped: user already exists', { email: normalizedEmail });
    return null;
  }

  if (password.length < 8) {
    logger.warn('ADMINPASS is shorter than the recommended minimum of 8 characters');
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, group_id, name, email_verified)
     VALUES ($1, $2, (SELECT id FROM groups WHERE key = 'admin'), 'Admin', true)
     RETURNING id`,
    [normalizedEmail, passwordHash]
  );
  logger.info('admin user seeded', { email: normalizedEmail });
  return rows[0].id;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  seedAdmin()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('admin seed failed', { error: err.message });
      process.exit(1);
    });
}
