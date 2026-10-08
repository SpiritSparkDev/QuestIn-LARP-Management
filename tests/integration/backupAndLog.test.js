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
