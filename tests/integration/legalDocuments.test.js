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

async function cookieFor(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Legal', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`legal-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return `session=${(await createSession(rows[0].id)).token}`;
}

test('legal documents: public read, admin-only write, validation, sanitizing', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}/legal-documents`;
    const admin = { 'Content-Type': 'application/json', Cookie: await cookieFor('admin') };
    const put = (body, headers = admin) => fetch(base, { method: 'PUT', headers, body: JSON.stringify(body) });

    await put({ privacy: { mode: 'none' }, imprint: { mode: 'none' } });
    assert.deepEqual(await (await fetch(base)).json(), { privacy: { mode: null, url: '', html: '' }, imprint: { mode: null, url: '', html: '' } });

    assert.equal((await put({ privacy: { mode: 'url', url: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await put({ privacy: { mode: 'url', url: 'ftp://x.de' } })).status, 400);
    assert.equal((await put({ imprint: { mode: 'bogus' } })).status, 400);

    const res = await put({
      privacy: { mode: 'url', url: ' https://example.com/dsgvo ' },
      imprint: { mode: 'text', html: '<p>Ich <b>bin</b><script>alert(1)</script> <a href="javascript:x()">x</a></p>' },
    });
    assert.equal(res.status, 200);
    const body = await (await fetch(base)).json(); // no auth
    assert.deepEqual(body.privacy, { mode: 'url', url: 'https://example.com/dsgvo', html: '' });
    assert.equal(body.imprint.mode, 'text');
    assert.equal(body.imprint.url, '');
    assert.ok(body.imprint.html.includes('<b>bin</b>'));
    assert.ok(!/script|javascript|alert/.test(body.imprint.html));

    // Only the submitted document changes; empty text means not configured.
    await put({ privacy: { mode: 'text', html: '<p> </p>' } });
    const after = await (await fetch(base)).json();
    assert.equal(after.privacy.mode, null);
    assert.equal(after.imprint.mode, 'text');

    assert.equal((await put({ privacy: { mode: 'none' } }, { 'Content-Type': 'application/json' })).status, 401);
    const member = { 'Content-Type': 'application/json', Cookie: await cookieFor('mitglied') };
    assert.equal((await put({ privacy: { mode: 'none' } }, member)).status, 403);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'legal-%'");
  await query('DELETE FROM app_settings');
  await closePool();
});
