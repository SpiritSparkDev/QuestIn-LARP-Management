import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.APP_BASE_URL = 'https://reset.example.test';
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { seedNscProfileSchema } = await import('../../db/seedNscProfileSchema.js');
await seedNscProfileSchema();

const { query, closePool } = await import('../../backend/db.js');
const { hashPassword } = await import('../../backend/crypto/password.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const reset = await import('../../backend/instanceReset/reset.js');

const PASSWORD = 'reset-passwort-123';

after(async () => {
  delete process.env.ADMINUSER;
  await closePool();
});

async function makeUser(email, groupKey) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, first_name, last_name, group_id, email_verified)
     VALUES ($1, $2, 'Reset', 'Test', (SELECT id FROM groups WHERE key = $3), true) RETURNING id`,
    [email, await hashPassword(PASSWORD), groupKey]
  );
  const session = await createSession(rows[0].id);
  return { id: rows[0].id, headers: { 'Content-Type': 'application/json', Cookie: `session=${session.token}` } };
}

const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);

test('every table is classified for the reset', async () => {
  const { rows } = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  const known = new Set([...reset.DATA_TABLES, ...reset.KEPT_FOR_ADMIN, ...reset.SETTINGS_TABLES, ...reset.SYSTEM_TABLES]);
  const unknown = rows.map((r) => r.table_name).filter((t) => !known.has(t));
  assert.deepEqual(unknown, [], 'Neue Tabelle: in backend/instanceReset/reset.js einer Liste zuordnen');
});

test('only the ADMINUSER admin can reset, with the instance name and the password', async () => {
  const adminEmail = `env-admin-${crypto.randomUUID()}@example.com`;
  process.env.ADMINUSER = adminEmail.toUpperCase();
  const envAdmin = await makeUser(adminEmail, 'admin');
  const otherAdmin = await makeUser(`other-admin-${crypto.randomUUID()}@example.com`, 'admin');
  const member = await makeUser(`member-${crypto.randomUUID()}@example.com`, 'mitglied');

  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const post = (who, body) => fetch(`${base}/instance-reset`, { method: 'POST', headers: who.headers, body: JSON.stringify(body) });

    assert.equal((await fetch(`${base}/instance-reset`, { headers: member.headers })).status, 403);
    const other = await (await fetch(`${base}/instance-reset`, { headers: otherAdmin.headers })).json();
    assert.equal(other.allowed, false);
    assert.equal((await post(otherAdmin, { confirm: 'reset.example.test', password: PASSWORD })).status, 403);

    const preview = await (await fetch(`${base}/instance-reset`, { headers: envAdmin.headers })).json();
    assert.equal(preview.allowed, true);
    assert.equal(preview.instanceName, 'reset.example.test');

    assert.equal((await post(envAdmin, { confirm: 'falsch.example.test', password: PASSWORD })).status, 400);
    assert.equal((await post(envAdmin, { confirm: 'reset.example.test', password: 'falsch' })).status, 403);
    assert.equal(await count('SELECT COUNT(*) AS n FROM users WHERE id = $1', [member.id]), 1);

    delete process.env.ADMINUSER;
    assert.equal((await post(envAdmin, { confirm: 'reset.example.test', password: PASSWORD })).status, 403);
  });
});

test('data reset deletes every account and all data but keeps the settings', async () => {
  const adminEmail = `env-admin-${crypto.randomUUID()}@example.com`;
  process.env.ADMINUSER = adminEmail;
  const envAdmin = await makeUser(adminEmail, 'admin');
  await makeUser(`other-${crypto.randomUUID()}@example.com`, 'mitglied');

  const { loadTestData, removeTestData } = await import('../../backend/testMode/load.js');
  await removeTestData();
  await loadTestData();
  await query(`INSERT INTO audit_log (action) VALUES ('test.something')`);
  await query(`INSERT INTO groups (key, name) VALUES ('eigene_rolle', 'Eigene Rolle') ON CONFLICT (key) DO NOTHING`);
  await query(`UPDATE app_settings SET app_title = 'Meine Orga'`);
  assert.ok(await count('SELECT COUNT(*) AS n FROM registrations') > 0);

  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/instance-reset`, {
      method: 'POST', headers: envAdmin.headers, body: JSON.stringify({ confirm: ' Reset.Example.Test ', password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.counts.users >= 76);
    assert.equal(body.includeSettings, false);

    // The admin is still signed in.
    assert.equal((await fetch(`http://localhost:${port}/instance-reset`, { headers: envAdmin.headers })).status, 200);
  });

  assert.deepEqual((await query('SELECT id FROM users')).rows.map((r) => r.id), [envAdmin.id]);
  for (const table of reset.DATA_TABLES.filter((t) => t !== 'audit_log')) {
    assert.equal(await count(`SELECT COUNT(*) AS n FROM ${table}`), 0, table);
  }
  assert.deepEqual((await query('SELECT action FROM audit_log')).rows.map((r) => r.action), ['instance.reset']);
  assert.equal(await count('SELECT COUNT(*) AS n FROM instance_authority WHERE event_id IS NOT NULL'), 0);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM groups WHERE key = 'eigene_rolle'`), 1);
  assert.equal((await query('SELECT app_title, test_mode_enabled FROM app_settings')).rows[0].app_title, 'Meine Orga');
  assert.equal((await query('SELECT test_mode_enabled FROM app_settings')).rows[0].test_mode_enabled, false);
});

test('reset with settings brings the configuration back to a fresh install', async () => {
  const adminEmail = `env-admin-${crypto.randomUUID()}@example.com`;
  process.env.ADMINUSER = adminEmail;
  const envAdmin = await makeUser(adminEmail, 'admin');
  await query(`INSERT INTO groups (key, name) VALUES ('eigene_rolle', 'Eigene Rolle') ON CONFLICT (key) DO NOTHING`);
  await query(`UPDATE groups SET name = 'Umbenannt' WHERE key = 'admin'`);
  await query(`UPDATE account_field_schema SET schema = '[]'::jsonb`);
  await query(`UPDATE app_settings SET app_title = 'Meine Orga'`);

  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/instance-reset`, {
      method: 'POST', headers: envAdmin.headers, body: JSON.stringify({ confirm: 'reset.example.test', password: PASSWORD, includeSettings: true }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).includeSettings, true);
  });

  assert.deepEqual((await query('SELECT id FROM users')).rows.map((r) => r.id), [envAdmin.id]);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM groups WHERE key = 'eigene_rolle'`), 0);
  assert.equal((await query(`SELECT name FROM groups WHERE key = 'admin'`)).rows[0].name, 'Admin');
  assert.equal(await count(`SELECT COUNT(*) AS n FROM users u JOIN groups g ON g.id = u.group_id WHERE g.key = 'admin'`), 1);
  const { GROUP_DEFAULTS } = await import('../../db/groupDefaults.js');
  const keys = (await query('SELECT key FROM groups')).rows.map((r) => r.key);
  for (const group of GROUP_DEFAULTS) assert.ok(keys.includes(group.key), group.key);
  assert.ok((await query('SELECT schema FROM account_field_schema')).rows[0].schema.length > 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM app_settings'), 0);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name LIKE 'questin_factory_%'`), 0);
});
