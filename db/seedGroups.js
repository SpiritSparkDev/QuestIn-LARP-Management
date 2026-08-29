import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { GROUP_DEFAULTS } from './groupDefaults.js';

// Idempotent: safe to run on every deploy/restart, and safe to call multiple
// times within the same process (e.g. once per test file sharing a DB).
export async function seedGroups() {
  for (const group of GROUP_DEFAULTS) {
    await query(
      `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, character_classes, can_override_checkin_status, is_protected)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO NOTHING`,
      [
        group.key,
        group.name,
        JSON.stringify(group.visibleMenus),
        JSON.stringify(group.accountFields),
        group.canEditCharacters,
        JSON.stringify(group.characterClasses),
        group.canOverrideCheckinStatus,
        group.isProtected,
      ]
    );
  }
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
