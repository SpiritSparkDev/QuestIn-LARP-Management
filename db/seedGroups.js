import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { GROUP_DEFAULTS } from './groupDefaults.js';

const ROLE_TO_GROUP_KEY = { admin: 'admin', checkin_helper: 'sl', participant: 'sc' };

// Idempotent: safe to run on every deploy/restart, and safe to call multiple
// times within the same process (e.g. once per test file sharing a DB).
//
// Note: the ALTER TABLE statements below run as raw DDL outside db/migrate.js
// (which wraps every change in a transaction + advisory lock). This is a
// known tradeoff, not an oversight — moving this into a real migration is
// tracked as a separate follow-up task, out of scope here.
export async function seedGroups() {
  for (const group of GROUP_DEFAULTS) {
    await query(
      `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, character_classes, is_protected)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO NOTHING`,
      [
        group.key,
        group.name,
        JSON.stringify(group.visibleMenus),
        JSON.stringify(group.accountFields),
        group.canEditCharacters,
        JSON.stringify(group.characterClasses),
        group.isProtected,
      ]
    );
  }

  const { rows: roleColumn } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`
  );
  if (roleColumn.length === 0) {
    // Already finalized in a previous run — nothing left to backfill.
    return;
  }

  for (const [role, groupKey] of Object.entries(ROLE_TO_GROUP_KEY)) {
    await query(
      `UPDATE users SET group_id = (SELECT id FROM groups WHERE key = $1)
       WHERE role = $2 AND group_id IS NULL`,
      [groupKey, role]
    );
  }

  await query('ALTER TABLE users ALTER COLUMN group_id SET NOT NULL');
  await query('ALTER TABLE users DROP COLUMN role');
  logger.info('users migrated from role to group_id; role column dropped');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  seedGroups()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('group seed failed', { error: err.message });
      process.exit(1);
    });
}
