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

  // Migration 014's own INSERT INTO groups statement still references the
  // character_classes column (dropped by migration 027, already applied at
  // this point since it ran the first time any test file in this shared DB
  // called runMigrations()) — restore it first, same "put back the schema
  // shape 014 expects" trick as the role column below, just for a column a
  // *later* migration removed instead of one a *later* migration added.
  const { rows: classesColumn } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'groups' AND column_name = 'character_classes'`
  );
  if (classesColumn.length === 0) {
    await query(`ALTER TABLE groups ADD COLUMN character_classes jsonb NOT NULL DEFAULT '[]'`);
  }

  // Wrapped in try/finally: if any assertion below throws, the cleanup in
  // `finally` still runs — otherwise the shared, non-reset test DB is left
  // with the 7 resurrected legacy groups and a restored character_classes
  // column, corrupting every other test file's "exactly 3 groups" / "no
  // character_classes column" assumptions for the rest of the suite run.
  let userId;
  try {
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, role) VALUES ($1, 'Backfill', 'Test', 'checkin_helper') RETURNING id",
      [`backfill-${crypto.randomUUID()}@example.com`]
    );
    userId = rows[0].id;

    await runMigrations();

    const { rows: after } = await query(
      `SELECT groups.key FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
      [userId]
    );
    assert.equal(after[0].key, 'sl');

    const { rows: roleColumnAfter } = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`
    );
    assert.equal(roleColumnAfter.length, 0);
  } finally {
    // Migration 014's INSERT (ON CONFLICT DO NOTHING) just resurrected the 7
    // legacy groups migration 027 already deleted, since they no longer exist
    // to conflict on. On a real from-scratch migrate run 014 runs BEFORE 027
    // deletes them, so this resurrection never happens there — undo it here so
    // this test doesn't leak state that breaks the "exactly 3 groups" and "no
    // character_classes column" invariants for every other test file sharing
    // this DB.
    if (userId) {
      await query('DELETE FROM users WHERE id = $1', [userId]);
    }
    await query(`DELETE FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl', 'nsc', 'gsc', 'sc')`);
    await query('ALTER TABLE groups DROP COLUMN character_classes');
  }
});

test('running twice does not duplicate groups or throw', async () => {
  await seedGroups();
  await seedGroups();
  const { rows } = await query('SELECT count(*)::int AS count FROM groups');
  assert.equal(rows[0].count, 3);
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
    assert.deepEqual([...row.account_fields].sort(), [...expected.accountFields].sort());
    assert.equal(row.can_edit_characters, expected.canEditCharacters);
    assert.equal(row.can_override_checkin_status, expected.canOverrideCheckinStatus);
    assert.equal(row.is_protected, expected.isProtected);
  }
});

test.after(async () => {
  await closePool();
});
