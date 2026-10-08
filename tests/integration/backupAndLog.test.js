import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { open } = await import('../../backend/offlinePackage/container.js');

after(closePool);

async function makeSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Log', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`backup-log-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

test('backup: admin only, passphrase required, encrypted, no secrets', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeSession('admin');
    const member = await makeSession('mitglied');
    const post = (cookie, body) => fetch(`${base}/backup/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });

    assert.equal((await post(member.cookie, { scope: 'all', passphrase: 'geheim-1234' })).status, 403);
    assert.equal((await post(admin.cookie, { scope: 'all', passphrase: 'kurz' })).status, 400);
    assert.equal((await post(admin.cookie, { scope: 'nope', passphrase: 'geheim-1234' })).status, 400);

    const res = await post(admin.cookie, { scope: 'all', passphrase: 'geheim-1234' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /\.qbak"/);
    const file = Buffer.from(await res.arrayBuffer());
    assert.throws(() => open(file, 'falsch-falsch'));
    const { manifest, data } = open(file, 'geheim-1234');
    assert.equal(manifest.kind, 'backup');
    assert.ok(data.participants.users.length >= 2);
    assert.ok(Array.isArray(data.events.metadata));
    assert.equal(JSON.stringify(data).includes('password_hash'), false);

    const history = await (await fetch(`${base}/backup/history`, { headers: { Cookie: admin.cookie } })).json();
    assert.equal(history[0].details.scope, 'all');
  });
});

test('log: character created/deleted and manual payment are recorded, profile edits are not', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeSession('admin');
    const player = await makeSession('mitglied');
    const json = (cookie, method, path, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
    const actions = async () => (await (await json(admin.cookie, 'GET', '/audit?limit=1000')).json()).map((e) => e.action);

    const paymentsBefore = (await actions()).filter((a) => a === 'payment.received').length;
    const created = await (await json(player.cookie, 'POST', '/characters', { name: 'Logbert', data: {} })).json();
    await json(player.cookie, 'PATCH', '/account', { nickname: 'Neuer Rufname' });
    await json(player.cookie, 'DELETE', `/characters/${created.id}`);

    const { rows: [event] } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Log Con', '2027-09-01', true) RETURNING id");
    const { rows: [character] } = await query("INSERT INTO characters (user_id, name, data) VALUES ($1, 'Zahler', '{}') RETURNING id", [player.userId]);
    await query("INSERT INTO registrations (user_id, event_id, status, character_id, amount_due_cents) VALUES ($1, $2, 'confirmed', $3, 5000)", [player.userId, event.id, character.id]);
    assert.equal((await json(admin.cookie, 'PATCH', `/events/${event.id}/registrations/${player.userId}/payment`, { markPaid: true })).status, 200);
    await json(admin.cookie, 'PATCH', `/events/${event.id}/registrations/${player.userId}/payment`, { markPaid: true });

    const seen = await actions();
    assert.ok(seen.includes('character.created'));
    assert.ok(seen.includes('character.deleted'));
    assert.equal(seen.filter((a) => a === 'payment.received').length - paymentsBefore, 1, 'a repeated click must not log a second payment');
    assert.equal(seen.some((a) => a.includes('account.') || a.includes('profile')), false, 'profile edits stay out of the log');
  });
});

test('backup: local target gets the file, an unconfigured target fails alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbak-'));
  process.env.BACKUP_LOCAL_DIR = dir;
  await withTestServer(async (port) => {
    const admin = await makeSession('admin');
    const res = await fetch(`http://localhost:${port}/backup/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ scope: 'events', passphrase: 'geheim-1234', targets: ['local', 'sftp'] }),
    });
    assert.equal(res.status, 200);
    const { filename, results } = await res.json();
    assert.equal(results.find((r) => r.target === 'local').ok, true);
    assert.equal(results.find((r) => r.target === 'sftp').ok, false);
    assert.ok(fs.existsSync(path.join(dir, filename)));
  });
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.BACKUP_LOCAL_DIR;
});

test('restore: wrong password is refused, a deleted character and registration come back', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeSession('admin');
    const player = await makeSession('mitglied');
    const json = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: JSON.stringify(body) });

    const { rows: [event] } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Restore Con', '2027-09-01', true) RETURNING id");
    const { rows: [character] } = await query("INSERT INTO characters (user_id, name, data) VALUES ($1, 'Phoenix', '{\"a\":1}') RETURNING id", [player.userId]);
    await query("INSERT INTO registrations (user_id, event_id, status, character_id, amount_due_cents) VALUES ($1, $2, 'confirmed', $3, 4200)", [player.userId, event.id, character.id]);

    const exported = await json('/backup/export', { scope: 'all', passphrase: 'geheim-1234', targets: ['download'] });
    const fileBase64 = Buffer.from(await exported.arrayBuffer()).toString('base64');

    assert.equal((await json('/backup/inspect', { fileBase64, passphrase: 'falsch-falsch' })).status, 400);
    const inspected = await (await json('/backup/inspect', { fileBase64, passphrase: 'geheim-1234' })).json();
    assert.equal(inspected.compatible, true);
    assert.deepEqual(inspected.parts.sort(), ['events', 'participants']);

    await query('DELETE FROM registrations WHERE event_id = $1', [event.id]);
    await query('DELETE FROM characters WHERE id = $1', [character.id]);
    await query('UPDATE events SET name = $2 WHERE id = $1', [event.id, 'Umbenannt']);

    assert.equal((await json('/backup/restore', { fileBase64, passphrase: 'geheim-1234', parts: ['participants', 'events'] })).status, 400, 'needs explicit confirmation');
    const restored = await json('/backup/restore', { fileBase64, passphrase: 'geheim-1234', parts: ['participants', 'events'], confirm: true });
    assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json()));

    const { rows: [char] } = await query('SELECT name, data FROM characters WHERE id = $1', [character.id]);
    assert.deepEqual(char, { name: 'Phoenix', data: { a: 1 } });
    const { rows: [reg] } = await query('SELECT amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [event.id, player.userId]);
    assert.equal(reg.amount_due_cents, 4200);
    const { rows: [ev] } = await query("SELECT name, to_char(event_date, 'YYYY-MM-DD') AS d FROM events WHERE id = $1", [event.id]);
    assert.deepEqual(ev, { name: 'Restore Con', d: '2027-09-01' });
  });
});
