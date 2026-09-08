import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'File', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`char-files-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeCharacter(userId) {
  const { rows } = await query(
    "INSERT INTO characters (user_id, event_id, class, name, data) VALUES ($1, NULL, 'nsc', 'File Test Char', '{}') RETURNING id",
    [userId]
  );
  return rows[0].id;
}

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('owner can upload, list, download, and delete their own file', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);

    const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'image', filename: 'portrait.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, isPublic: false, gdprConsent: true }),
    });
    assert.equal(uploadRes.status, 201);
    const uploaded = await uploadRes.json();
    assert.equal(uploaded.original_filename, 'portrait.png');

    const listRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, { headers: { Cookie: owner.cookie } });
    const list = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, uploaded.id);

    const downloadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${uploaded.id}`, { headers: { Cookie: owner.cookie } });
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.headers.get('content-type'), 'image/png');
    const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
    assert.deepEqual(downloadedBytes, Buffer.from(TINY_PNG_BASE64, 'base64'));

    const deleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${uploaded.id}`, { method: 'DELETE', headers: { Cookie: owner.cookie } });
    assert.equal(deleteRes.status, 200);
    const afterDeleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${uploaded.id}`, { headers: { Cookie: owner.cookie } });
    assert.equal(afterDeleteRes.status, 404);
  });
});

test('a private file is invisible (list) and unreachable (download) to a non-owner, non-elevated stranger', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const stranger = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);

    const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'image', filename: 'private.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, isPublic: false, gdprConsent: true }),
    });
    const { id: fileId } = await uploadRes.json();

    const listRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, { headers: { Cookie: stranger.cookie } });
    assert.deepEqual(await listRes.json(), []);

    const downloadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(downloadRes.status, 404);

    const deleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { method: 'DELETE', headers: { Cookie: stranger.cookie } });
    assert.equal(deleteRes.status, 403);
  });
});

test('a public file is visible and downloadable by anyone authenticated, but only deletable by owner/elevated', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const stranger = await makeUserAndSession('mitglied');
    const elevated = await makeUserAndSession('admin');
    const characterId = await makeCharacter(owner.userId);

    const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'image', filename: 'public.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, isPublic: true, gdprConsent: true }),
    });
    const { id: fileId } = await uploadRes.json();

    const strangerListRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, { headers: { Cookie: stranger.cookie } });
    assert.equal((await strangerListRes.json()).length, 1);

    const strangerDownloadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { headers: { Cookie: stranger.cookie } });
    assert.equal(strangerDownloadRes.status, 200);

    const strangerDeleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { method: 'DELETE', headers: { Cookie: stranger.cookie } });
    assert.equal(strangerDeleteRes.status, 403);

    const elevatedDeleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { method: 'DELETE', headers: { Cookie: elevated.cookie } });
    assert.equal(elevatedDeleteRes.status, 200);
  });
});

test('upload rejects missing GDPR consent, disallowed mime types, and oversized files', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);
    const base = { kind: 'image', filename: 'x.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64 };

    const noConsentRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ ...base, gdprConsent: false }),
    });
    assert.equal(noConsentRes.status, 400);

    const badMimeRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ ...base, mimeType: 'application/x-msdownload', gdprConsent: true }),
    });
    assert.equal(badMimeRes.status, 400);

    const oversizedBase64 = Buffer.alloc(21 * 1024 * 1024).toString('base64');
    const oversizedRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ ...base, dataBase64: oversizedBase64, gdprConsent: true }),
    });
    assert.equal(oversizedRes.status, 413);
  });
});

test('upload rejects a file that would exceed the per-character quota', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ quotaMbPerCharacter: 1 }),
    });

    const owner = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);
    const almostOneMb = Buffer.alloc(900 * 1024).toString('base64');

    const firstRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'document', filename: 'a.pdf', mimeType: 'application/pdf', dataBase64: almostOneMb, gdprConsent: true }),
    });
    assert.equal(firstRes.status, 201);

    const secondRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'document', filename: 'b.pdf', mimeType: 'application/pdf', dataBase64: almostOneMb, gdprConsent: true }),
    });
    assert.equal(secondRes.status, 413);

    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ quotaMbPerCharacter: 100 }),
    });
  });
});

test('a fileId that exists but under the wrong characterId in the URL 404s, not 200', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);
    const otherCharacterId = await makeCharacter(owner.userId);

    const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'image', filename: 'x.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, gdprConsent: true }),
    });
    const { id: fileId } = await uploadRes.json();

    const mismatchedRes = await fetch(`http://localhost:${port}/characters/${otherCharacterId}/files/${fileId}`, { headers: { Cookie: owner.cookie } });
    assert.equal(mismatchedRes.status, 404);
  });
});

test('upload against a broken external backend surfaces 502, not silently succeeding or 500', async () => {
  await withTestServer(async (port) => {
    await query(
      `INSERT INTO storage_settings (backend, s3_bucket, s3_region, s3_endpoint, s3_access_key_id)
       VALUES ('s3', 'nonexistent-bucket', 'us-east-1', 'http://127.0.0.1:1', 'x')`
    );
    try {
      const owner = await makeUserAndSession('mitglied');
      const characterId = await makeCharacter(owner.userId);
      const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
        body: JSON.stringify({ kind: 'image', filename: 'x.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, gdprConsent: true }),
      });
      assert.equal(uploadRes.status, 502);
    } finally {
      await query('DELETE FROM storage_settings');
    }
  });
});

test('a file already stored on "local" is still served correctly even while a different backend is active', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);
    const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'image', filename: 'x.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, gdprConsent: true }),
    });
    const { id: fileId } = await uploadRes.json();

    // Switch the active backend to something unreachable AFTER the file was
    // already uploaded to 'local' -- the file's own stamped storage_backend
    // must still control where it's read from, not whatever is active now.
    await query(
      `INSERT INTO storage_settings (backend, s3_bucket, s3_region, s3_endpoint, s3_access_key_id)
       VALUES ('s3', 'nonexistent-bucket', 'us-east-1', 'http://127.0.0.1:1', 'x')`
    );
    try {
      const downloadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { headers: { Cookie: owner.cookie } });
      assert.equal(downloadRes.status, 200);
    } finally {
      await query('DELETE FROM storage_settings');
    }
  });
});

test('delete surfaces 502 if removal from an external backend fails, even though the DB row is already gone', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('mitglied');
    const characterId = await makeCharacter(owner.userId);
    await query(
      `INSERT INTO storage_settings (backend, s3_bucket, s3_region, s3_endpoint, s3_access_key_id)
       VALUES ('s3', 'nonexistent-bucket', 'us-east-1', 'http://127.0.0.1:1', 'x')`
    );
    try {
      const { rows } = await query(
        `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, storage_backend)
         VALUES (gen_random_uuid(), $1, $2, 'image', 'x.png', 'image/png', 10, 's3') RETURNING id`,
        [characterId, owner.userId]
      );
      const fileId = rows[0].id;

      const deleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { method: 'DELETE', headers: { Cookie: owner.cookie } });
      assert.equal(deleteRes.status, 502);
    } finally {
      await query('DELETE FROM storage_settings');
    }
  });
});

test.after(async () => {
  await query("DELETE FROM characters WHERE name = 'File Test Char'");
  await query("DELETE FROM users WHERE email LIKE 'char-files-%'");
  await query('UPDATE app_settings SET quota_mb_per_character = 100');
  await closePool();
});
