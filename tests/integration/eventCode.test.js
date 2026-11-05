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

async function adminCookie() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Code', 'Test', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
    [`eventcode-${crypto.randomUUID()}@example.com`]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  return `session=${(await createSession(rows[0].id)).token}`;
}

test('event code: unique case-insensitively on create and update', async () => {
  await withTestServer(async (port) => {
    const cookie = await adminCookie();
    const call = (method, path, body) => fetch(`http://localhost:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    });
    const code = `UC-${crypto.randomUUID().slice(0, 8)}`;

    const a = await call('POST', '/events', { name: 'Code A', eventDate: '2031-01-01', code });
    assert.equal(a.status, 201);
    const eventA = await a.json();

    const dup = await call('POST', '/events', { name: 'Code B', eventDate: '2031-01-02', code: code.toLowerCase() });
    assert.equal(dup.status, 409);
    assert.match((await dup.json()).error, /"Code A"/);

    const b = await call('POST', '/events', { name: 'Code B', eventDate: '2031-01-02', code: `${code}-b` });
    assert.equal(b.status, 201);
    const eventB = await b.json();

    const clash = await call('PUT', `/events/${eventB.id}`, { code: code.toUpperCase() });
    assert.equal(clash.status, 409);

    const own = await call('PUT', `/events/${eventA.id}`, { code, name: 'Code A2' });
    assert.equal(own.status, 200);

    // blank codes may repeat
    for (const n of [1, 2]) {
      const r = await call('POST', '/events', { name: `Blank ${n}`, eventDate: '2031-02-01', code: '' });
      assert.equal(r.status, 201);
    }

    const list = await (await fetch(`http://localhost:${port}/events`, { headers: { Cookie: cookie } })).json();
    assert.equal(list.find((e) => e.id === eventA.id).code, code);
  });
});

test.after(() => closePool());
