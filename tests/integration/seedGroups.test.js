import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
const { query, closePool } = await import('../../backend/db.js');

// This file's schema-mutating setup (re-adding/dropping the `role` column,
// toggling group_id NOT NULL) is only safe because package.json's `test`
// script runs with --test-concurrency=1 (sequential file execution). Without
// that flag this races with other test files' seedGroups() calls, causing
// the intermittent "column role does not exist" failures an earlier fix
// round in this codebase had to chase down.

// The shared test DB is not reset between runs (tmpfs, only cleared on
// container restart), so a prior run's seedGroups() call may have already
// dropped `role`. Restore it (matching its definition in
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
  // pre-finalization schema seedGroups() expects to backfill.
  await query('ALTER TABLE users ALTER COLUMN group_id DROP NOT NULL');
}

// This test must run first (before any other test's seedGroups() call) —
// only at this point does the `role` column still exist, so it's the only
// place the real backfill path is exercised rather than the "already
// finalized" no-op path.
test('backfills group_id for a user with an existing role value, then drops the role column', async () => {
  const { rows } = await query(
    "INSERT INTO users (email, name, role) VALUES ($1, 'Backfill Test', 'checkin_helper') RETURNING id",
    [`backfill-${crypto.randomUUID()}@example.com`]
  );
  await seedGroups();
  const { rows: after } = await query(
    `SELECT groups.key FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [rows[0].id]
  );
  assert.equal(after[0].key, 'sl');
});

test('seeds all 8 default groups', async () => {
  await seedGroups();
  const { rows } = await query('SELECT key FROM groups ORDER BY key');
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, ['admin', 'gsc', 'hilfs_sl', 'nsc', 'orga', 'plot_orga', 'sc', 'sl']);
});

test('running twice does not duplicate groups or throw', async () => {
  await seedGroups();
  await seedGroups();
  const { rows } = await query('SELECT count(*)::int AS count FROM groups');
  assert.equal(rows[0].count, 8);
});

test('admin group has every menu and can edit characters', async () => {
  await seedGroups();
  const { rows } = await query('SELECT visible_menus, can_edit_characters FROM groups WHERE key = $1', ['admin']);
  assert.deepEqual(rows[0].visible_menus.sort(), ['charaktere', 'checkin', 'events', 'konto', 'mitglieder']);
  assert.equal(rows[0].can_edit_characters, true);
});

test.after(async () => {
  await closePool();
});
