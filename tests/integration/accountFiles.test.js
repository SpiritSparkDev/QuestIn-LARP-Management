import { test, after } from 'node:test';
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

after(closePool);

async function makeSession() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Acc', 'File', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`acc-files-${crypto.randomUUID()}@example.com`]
  );
  return `session=${(await createSession(rows[0].id)).token}`;
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('account file: upload, set as profile picture, private to owner, delete', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const owner = await makeSession();
    const other = await makeSession();
    const json = (cookie, method, path, body) => fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body),
    });

    const up = await json(owner, 'POST', '/account/files', { kind: 'image', filename: 'me.png', mimeType: 'image/png', dataBase64: PNG, gdprConsent: true });
    assert.equal(up.status, 201);
    const file = await up.json();

    assert.equal((await json(owner, 'PUT', '/account/portrait', { fileId: file.id })).status, 200);
    assert.equal((await (await json(owner, 'GET', '/account')).json()).avatarFileId, file.id);

    assert.equal((await json(owner, 'GET', `/account/files/${file.id}`)).status, 200);
    assert.equal((await json(other, 'GET', `/account/files/${file.id}`)).status, 404);
    assert.equal((await json(other, 'PUT', '/account/portrait', { fileId: file.id })).status, 404);

    assert.equal((await json(owner, 'DELETE', `/account/files/${file.id}`)).status, 200);
    assert.equal((await (await json(owner, 'GET', '/account')).json()).avatarFileId, null);
  });
});
