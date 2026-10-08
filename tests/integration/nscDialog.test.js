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
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');
const { buildBackup } = await import('../../backend/backup/dump.js');

after(closePool);

async function makeSession(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Dia', 'Log', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`nsc-dialog-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

async function setup({ conRole = 'nsc', nscAvailable = false } = {}) {
  const staff = await makeSession('moderator');
  const player = await makeSession('mitglied');
  const stranger = await makeSession('mitglied');
  const { rows: [event] } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('Dialog Con', '2027-09-01', true) RETURNING id");
  await query('INSERT INTO registrations (user_id, event_id, con_role, nsc_available) VALUES ($1, $2, $3, $4)', [player.userId, event.id, conRole, nscAvailable]);
  return { staff, player, stranger, eventId: event.id };
}

const json = (cookie, method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });

test('thread: player and staff exchange messages, read flags follow the reader', async () => {
  resetRateLimits();
  const { staff, player, stranger, eventId } = await setup();
  await withTestServer(async (port) => {
    const own = `http://localhost:${port}/events/${eventId}/nsc-dialog`;
    const staffUrl = `http://localhost:${port}/events/${eventId}/nsc-dialogs/${player.userId}`;

    assert.equal((await json(player.cookie, 'POST', own, { body: '<b>Ich spiele gern Wirte</b>' })).status, 201);
    assert.equal((await json(player.cookie, 'POST', own, { body: '   ' })).status, 400);
    assert.equal((await json(player.cookie, 'POST', own, { body: 'x'.repeat(2001) })).status, 400);

    const overview = await (await json(staff.cookie, 'GET', `http://localhost:${port}/events/${eventId}/nsc-dialogs`)).json();
    assert.equal(overview.length, 1);
    assert.equal(overview[0].unread, 1);

    const thread = await (await json(staff.cookie, 'GET', staffUrl)).json();
    assert.equal(thread[0].body, '<b>Ich spiele gern Wirte</b>');
    assert.equal(thread[0].from, 'player');
    const after = await (await json(staff.cookie, 'GET', `http://localhost:${port}/events/${eventId}/nsc-dialogs`)).json();
    assert.equal(after[0].unread, 0);

    assert.equal((await json(staff.cookie, 'POST', staffUrl, { body: 'Gern!' })).status, 201);
    const mine = await (await json(player.cookie, 'GET', own)).json();
    assert.deepEqual(mine.map((m) => m.from), ['player', 'staff']);
    assert.equal(mine[1].unread, true);
    assert.equal(JSON.stringify(mine).includes('author'), false);
    assert.equal((await (await json(player.cookie, 'GET', own)).json())[1].unread, false);

    // Players cannot use the staff routes, nor can they send proposals.
    assert.equal((await json(player.cookie, 'GET', staffUrl)).status, 403);
    assert.equal((await json(player.cookie, 'POST', own, { body: 'x', proposal: { roleName: 'Boss' } })).status, 201);
    const last = (await (await json(player.cookie, 'GET', own)).json()).at(-1);
    assert.equal(last.proposal, null);

    // A stranger without NSC registration has no dialog and sees nothing of others.
    assert.equal((await json(stranger.cookie, 'GET', own)).status, 404);
    assert.equal((await json(stranger.cookie, 'POST', own, { body: 'hallo' })).status, 404);
  });
});

test('proposal: staff proposes a role, only the player can accept or decline once', async () => {
  resetRateLimits();
  const { staff, player, stranger, eventId } = await setup();
  await withTestServer(async (port) => {
    const own = `http://localhost:${port}/events/${eventId}/nsc-dialog`;
    const staffUrl = `http://localhost:${port}/events/${eventId}/nsc-dialogs/${player.userId}`;
    assert.equal((await json(staff.cookie, 'POST', staffUrl, { body: 'Wie wäre es hiermit?', proposal: { roleName: '', description: 'x' } })).status, 400);
    assert.equal((await json(staff.cookie, 'POST', staffUrl, { body: 'Wie wäre es hiermit?', proposal: { roleName: 'Hofnarr', description: 'Spaßmacher' } })).status, 201);

    const [msg] = await (await json(player.cookie, 'GET', own)).json();
    assert.deepEqual(msg.proposal, { roleName: 'Hofnarr', description: 'Spaßmacher', status: 'open' });

    assert.equal((await json(stranger.cookie, 'PATCH', `${own}/${msg.id}`, { accept: true })).status, 404);
    assert.equal((await json(player.cookie, 'PATCH', `${own}/${msg.id}`, {})).status, 400);
    const accepted = await (await json(player.cookie, 'PATCH', `${own}/${msg.id}`, { accept: true })).json();
    assert.equal(accepted[0].proposal.status, 'accepted');
    assert.equal((await json(player.cookie, 'PATCH', `${own}/${msg.id}`, { accept: false })).status, 409);

    const overview = await (await json(staff.cookie, 'GET', `http://localhost:${port}/events/${eventId}/nsc-dialogs`)).json();
    assert.deepEqual(overview[0].acceptedRoles, ['Hofnarr']);
    assert.equal(overview[0].openProposals, 0);
  });
});

test('only NSC-related registrations have a dialog', async () => {
  resetRateLimits();
  const sc = await setup({ conRole: 'sc' });
  const both = await setup({ conRole: 'sc', nscAvailable: true });
  await withTestServer(async (port) => {
    assert.equal((await json(sc.player.cookie, 'GET', `http://localhost:${port}/events/${sc.eventId}/nsc-dialog`)).status, 404);
    assert.equal((await json(sc.staff.cookie, 'POST', `http://localhost:${port}/events/${sc.eventId}/nsc-dialogs/${sc.player.userId}`, { body: 'hi' })).status, 404);
    assert.equal((await json(both.player.cookie, 'POST', `http://localhost:${port}/events/${both.eventId}/nsc-dialog`, { body: 'bereit' })).status, 201);
  });
});

test('player messages are rate limited', async () => {
  resetRateLimits();
  const { player, eventId } = await setup();
  await withTestServer(async (port) => {
    const own = `http://localhost:${port}/events/${eventId}/nsc-dialog`;
    for (let i = 0; i < 10; i++) assert.equal((await json(player.cookie, 'POST', own, { body: `n${i}` })).status, 201);
    assert.equal((await json(player.cookie, 'POST', own, { body: 'zu viel' })).status, 429);
  });
});

test('deletion: event, account and unregistering remove the dialog; backup includes it', async () => {
  resetRateLimits();
  const a = await setup();
  const b = await setup();
  const c = await setup();
  for (const s of [a, b, c]) {
    await query("INSERT INTO nsc_dialog_messages (event_id, user_id, author_id, author_side, body) VALUES ($1, $2, $2, 'player', 'hi')", [s.eventId, s.player.userId]);
  }
  const backup = await buildBackup('participants');
  assert.ok(backup.data.participants.nsc_dialog_messages.length >= 3);

  const count = async (eventId) => (await query('SELECT COUNT(*)::int AS n FROM nsc_dialog_messages WHERE event_id = $1', [eventId])).rows[0].n;
  await query('DELETE FROM events WHERE id = $1', [a.eventId]);
  assert.equal(await count(a.eventId), 0);
  await query('DELETE FROM users WHERE id = $1', [b.player.userId]);
  assert.equal(await count(b.eventId), 0);
  await query('DELETE FROM registrations WHERE event_id = $1', [c.eventId]);
  assert.equal(await count(c.eventId), 0);
});

test('privacy deletion of the teilnahme category wipes the dialog', async () => {
  const { player, eventId } = await setup();
  await query("INSERT INTO nsc_dialog_messages (event_id, user_id, author_id, author_side, body) VALUES ($1, $2, $2, 'player', 'hi')", [eventId, player.userId]);
  await query(
    "UPDATE events SET ended_at = now() - interval '1 year', privacy_deletion = $2 WHERE id = $1",
    [eventId, JSON.stringify({ fields: { 'registration:x': 'teilnahme' }, rules: { teilnahme: { mode: 'auto', days: 1 } } })]
  );
  const { runPrivacyDeletion } = await import('../../backend/privacy/repository.js');
  assert.equal(await runPrivacyDeletion(eventId, 'teilnahme'), true);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM nsc_dialog_messages WHERE event_id = $1', [eventId])).rows[0].n, 0);
});
