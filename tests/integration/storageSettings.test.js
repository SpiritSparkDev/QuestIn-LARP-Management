import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Storage', 'Settings Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`storage-settings-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeCharacter(userId) {
  const { rows } = await query(
    "INSERT INTO characters (user_id, event_id, class, name, data) VALUES ($1, NULL, 'nsc', 'Storage Test Char', '{}') RETURNING id",
    [userId]
  );
  return rows[0].id;
}

test('PUT then GET /admin/settings/storage never returns plaintext secrets', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const putRes = await fetch(`http://localhost:${port}/admin/settings/storage`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        backend: 'ftp',
        ftp: { host: 'ftp.example.com', port: 21, username: 'bot', password: 'ftp-secret', secure: true, baseDir: '/uploads' },
        s3: {},
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.ftp.hasPassword, true);
    assert.ok(!JSON.stringify(putBody).includes('ftp-secret'));

    const getRes = await fetch(`http://localhost:${port}/admin/settings/storage`, { headers: { Cookie: cookie } });
    const getBody = await getRes.json();
    assert.equal(getBody.backend, 'ftp');
    assert.ok(!JSON.stringify(getBody).includes('ftp-secret'));
  });
});

test('GET/PUT/test/usage/migrate on /admin/settings/storage all reject a non-admin group', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const calls = [
      ['GET', '/admin/settings/storage', undefined],
      ['PUT', '/admin/settings/storage', JSON.stringify({ backend: 'local' })],
      ['POST', '/admin/settings/storage/test', JSON.stringify({ backend: 'local' })],
      ['GET', '/admin/settings/storage/usage', undefined],
      ['POST', '/admin/settings/storage/migrate', undefined],
    ];
    for (const [method, path, body] of calls) {
      const res = await fetch(`http://localhost:${port}${path}`, {
        method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body,
      });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });
});

test('test-connection succeeds for the local backend and fails for an unreachable s3 config', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const localRes = await fetch(`http://localhost:${port}/admin/settings/storage/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ backend: 'local' }),
    });
    assert.equal(localRes.status, 200);

    const s3Res = await fetch(`http://localhost:${port}/admin/settings/storage/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ backend: 's3', s3: { bucket: 'x', region: 'us-east-1', endpoint: 'http://127.0.0.1:1', accessKeyId: 'x', secretAccessKey: 'x' } }),
    });
    assert.equal(s3Res.status, 502);
  });
});

test('usage aggregates size_bytes per backend', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);
    await query(
      `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, storage_backend)
       VALUES (gen_random_uuid(), $1, $2, 'document', 'a.pdf', 'application/pdf', 12345, 'local')`,
      [characterId, owner.userId]
    );
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/admin/settings/storage/usage`, { headers: { Cookie: cookie } });
    const body = await res.json();
    assert.ok(body.local >= 12345);
  });
});

test('migrate reports a broken file as failed instead of crashing or silently dropping it', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);
    const { rows } = await query(
      `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, storage_backend)
       VALUES (gen_random_uuid(), $1, $2, 'image', 'x.png', 'image/png', 10, 's3') RETURNING id`,
      [characterId, owner.userId]
    );
    const brokenFileId = rows[0].id;

    await query('DELETE FROM storage_settings');
    await query(
      `INSERT INTO storage_settings (backend, s3_bucket, s3_region, s3_endpoint, s3_access_key_id)
       VALUES ('local', 'nonexistent', 'us-east-1', 'http://127.0.0.1:1', 'x')`
    );
    try {
      const { cookie } = await makeUserAndSession('admin');
      const res = await fetch(`http://localhost:${port}/admin/settings/storage/migrate`, {
        method: 'POST', headers: { Cookie: cookie },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.migrated, 0);
      assert.equal(body.failed.length, 1);
      assert.equal(body.failed[0].id, brokenFileId);
    } finally {
      await query('DELETE FROM storage_settings');
    }
  });
});

test.after(async () => {
  await query("DELETE FROM characters WHERE name = 'Storage Test Char'");
  await query("DELETE FROM users WHERE email LIKE 'storage-settings-%'");
  await query('DELETE FROM storage_settings');
  await closePool();
});
