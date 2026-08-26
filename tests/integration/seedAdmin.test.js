import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { seedAdmin } = await import('../../db/seedAdmin.js');
const { query, closePool } = await import('../../backend/db.js');
const { verifyPassword } = await import('../../backend/crypto/password.js');

test('does nothing when ADMINUSER/ADMINPASS are not set', async () => {
  delete process.env.ADMINUSER;
  delete process.env.ADMINPASS;
  const result = await seedAdmin();
  assert.equal(result, null);
});

test('creates a verified admin user from ADMINUSER/ADMINPASS', async () => {
  const email = `admin-seed-${crypto.randomUUID()}@example.com`;
  process.env.ADMINUSER = email;
  process.env.ADMINPASS = 'super-secret-password';

  const userId = await seedAdmin();
  assert.ok(userId);

  const { rows } = await query(
    `SELECT groups.key AS group_key, users.email_verified, users.password_hash
     FROM users JOIN groups ON groups.id = users.group_id WHERE users.id = $1`,
    [userId]
  );
  assert.equal(rows[0].group_key, 'admin');
  assert.equal(rows[0].email_verified, true);
  assert.equal(await verifyPassword('super-secret-password', rows[0].password_hash), true);

  delete process.env.ADMINUSER;
  delete process.env.ADMINPASS;
  await query('DELETE FROM users WHERE id = $1', [userId]);
});

test('running twice does not create a duplicate or throw', async () => {
  const email = `admin-seed-dup-${crypto.randomUUID()}@example.com`;
  process.env.ADMINUSER = email;
  process.env.ADMINPASS = 'super-secret-password';

  const firstId = await seedAdmin();
  const secondResult = await seedAdmin();
  assert.equal(secondResult, null);

  const { rows } = await query(
    'SELECT count(*)::int AS count FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  assert.equal(rows[0].count, 1);

  delete process.env.ADMINUSER;
  delete process.env.ADMINPASS;
  await query('DELETE FROM users WHERE id = $1', [firstId]);
});

test.after(async () => {
  await closePool();
});
