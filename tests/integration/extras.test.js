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
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Extras', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`extras-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('extras: booking, sold-out, price changes, removal and payment lock', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUserAndSession('admin');
    const alice = await makeUserAndSession();
    const bob = await makeUserAndSession();
    const json = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });

    const created = await fetch(`${base}/events`, {
      method: 'POST', headers: json(admin.cookie),
      body: JSON.stringify({
        name: 'Extras Con', eventDate: '2099-08-01',
        extras: [
          { name: 'Hütte', description: 'Bett im Haus', priceCents: 2500, capacity: 2 },
          { name: 'Stellplatz', priceCents: 1000 },
        ],
      }),
    });
    assert.equal(created.status, 201);
    const event = await created.json();
    await query('UPDATE events SET is_active = true WHERE id = $1', [event.id]);
    const [hut, pitch] = event.extras;
    assert.ok(hut.id && pitch.id);

    const bad = await fetch(`${base}/events`, {
      method: 'POST', headers: json(admin.cookie),
      body: JSON.stringify({ name: 'Bad', eventDate: '2099-08-01', extras: [{ name: 'X', priceCents: -1 }] }),
    });
    assert.equal(bad.status, 400);

    const register = (cookie, extras) => fetch(`${base}/events/${event.id}/register`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ conRole: 'helfer', extras }),
    });

    assert.equal((await register(alice.cookie, { [crypto.randomUUID()]: 1 })).status, 400);
    const res = await register(alice.cookie, { [hut.id]: 1, [pitch.id]: 2 });
    assert.equal(res.status, 201);
    const aliceReg = await res.json();
    assert.deepEqual(aliceReg.extras, { [hut.id]: 1, [pitch.id]: 2 });
    const amount = async (userId) => (await query('SELECT amount_due_cents, extras_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [event.id, userId])).rows[0];
    assert.deepEqual(await amount(alice.userId), { amount_due_cents: 4500, extras_cents: 4500 });

    // Capacity 2 cabins: one is taken, so two more are too many -- one is fine.
    const tooMany = await register(bob.cookie, { [hut.id]: 2 });
    assert.equal(tooMany.status, 409);
    assert.match((await tooMany.json()).error, /nur noch 1/);

    const put = (cookie, userId, extras) => fetch(`${base}/events/${event.id}/registrations/${userId}/extras`, {
      method: 'PUT', headers: json(cookie), body: JSON.stringify({ extras }),
    });
    assert.equal((await put(bob.cookie, alice.userId, {})).status, 403);

    const changed = await put(alice.cookie, alice.userId, { [hut.id]: 2 });
    assert.equal(changed.status, 200);
    assert.deepEqual(await amount(alice.userId), { amount_due_cents: 5000, extras_cents: 5000 });

    // A manual price adjustment survives later extras changes (delta based).
    await query('UPDATE registrations SET amount_due_cents = 4000 WHERE event_id = $1 AND user_id = $2', [event.id, alice.userId]);
    assert.equal((await put(alice.cookie, alice.userId, { [hut.id]: 1 })).status, 200);
    assert.deepEqual(await amount(alice.userId), { amount_due_cents: 1500, extras_cents: 2500 });

    // A booked extra can't be removed from the event.
    const removal = await fetch(`${base}/events/${event.id}`, {
      method: 'PUT', headers: json(admin.cookie), body: JSON.stringify({ extras: [pitch] }),
    });
    assert.equal(removal.status, 409);

    // The participants list shows what was booked.
    const participants = await (await fetch(`${base}/events/${event.id}/participants`, { headers: json(admin.cookie) })).json();
    assert.equal(participants.find((p) => p.userId === alice.userId).extrasText, '1× Hütte');

    // Paid registrations are locked.
    await query('UPDATE registrations SET paid_at = now() WHERE event_id = $1 AND user_id = $2', [event.id, alice.userId]);
    const locked = await put(alice.cookie, alice.userId, {});
    assert.equal(locked.status, 409);
    assert.match((await locked.json()).error, /bezahlt/);
  });
});

test.after(async () => {
  await query("DELETE FROM events WHERE name IN ('Extras Con', 'Bad')");
  await query("DELETE FROM users WHERE email LIKE 'extras-%'");
  await closePool();
});
