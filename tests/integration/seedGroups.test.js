import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GROUP_DEFAULTS } from '../../db/groupDefaults.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
const { query, closePool } = await import('../../backend/db.js');

// This file's schema-mutating setup (re-adding the `role` column, relaxing
// group_id NOT NULL, and re-running migration 014) is only safe because
// package.json's `test` script runs with --test-concurrency=1 (sequential
// file execution). Without that flag this would race with other test
// files' runMigrations()/seedGroups() calls against the same shared DB.

// The shared test DB is not reset between runs (tmpfs, only cleared on
// container restart), so a prior run may have already applied migration
// 014 and dropped `role`. Restore both (matching users' original shape from
// 001_users_and_sessions.sql) so the backfill test below always has a
// role-bearing column to exercise, regardless of what earlier runs did.
const { rows: roleColumn } = await query(
  `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`
);
if (roleColumn.length === 0) {
  await query(
    `ALTER TABLE users ADD COLUMN role text not null default 'participant' check (role in ('participant', 'admin', 'checkin_helper'))`
  );
  // A prior finalization also set group_id NOT NULL; relax it back so a
  // role-only insert (no group_id yet) is legal again, matching the
  // pre-finalization schema the migration expects to backfill.
  await query('ALTER TABLE users ALTER COLUMN group_id DROP NOT NULL');
}

// This test must run first (before any other test in this file calls
// seedGroups()) — only at this point does the `role` column still exist,
// so it's the only place the real backfill path is exercised rather than
// the "already finalized, role column absent" no-op path.
test('migration 014 backfills group_id for a user with an existing role value, then drops the role column', async () => {
  // Force migration 014 to be treated as "not yet applied" so runMigrations()
  // re-executes it against the just-restored pre-migration schema shape.
  await query(`DELETE FROM schema_migrations WHERE filename = '014_finalize_group_id.sql'`);

  const { rows } = await query(
    "INSERT INTO users (email, name, role) VALUES ($1, 'Backfill Test', 'checkin_helper') RETURNING id",
    [`backfill-${crypto.randomUUID()}@example.com`]
  );

  await runMigrations();

  const { rows: after } = await query(
    `SELECT groups.key FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [rows[0].id]
  );
  assert.equal(after[0].key, 'sl');

  const { rows: roleColumnAfter } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`
  );
  assert.equal(roleColumnAfter.length, 0);
});

test('running twice does not duplicate groups or throw', async () => {
  await seedGroups();
  await seedGroups();
  const { rows } = await query('SELECT count(*)::int AS count FROM groups');
  assert.equal(rows[0].count, 8);
});

test('every seeded group matches GROUP_DEFAULTS field-for-field', async () => {
  await seedGroups();
  const { rows } = await query('SELECT * FROM groups ORDER BY key');
  assert.equal(rows.length, GROUP_DEFAULTS.length);
  for (const expected of GROUP_DEFAULTS) {
    const row = rows.find((r) => r.key === expected.key);
    assert.ok(row, `missing group: ${expected.key}`);
    assert.equal(row.name, expected.name);
    assert.deepEqual(row.visible_menus, expected.visibleMenus);
    assert.deepEqual(row.account_fields, expected.accountFields);
    assert.equal(row.can_edit_characters, expected.canEditCharacters);
    assert.deepEqual(row.character_classes, expected.characterClasses);
    assert.equal(row.can_override_checkin_status, expected.canOverrideCheckinStatus);
    assert.equal(row.is_protected, expected.isProtected);
  }
});

test.after(async () => {
  await closePool();
});
