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
const { runUnpaidReminders } = await import('../../backend/registrations/unpaidReminders.js');
const { runConPayerAutomation } = await import('../../backend/registrations/conPayerAutomation.js');

const TAG = `conpayer-${crypto.randomUUID().slice(0, 6)}`;

async function makeUser(groupKey, firstName) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, $2, 'Test', (SELECT id FROM groups WHERE key = $3), true) RETURNING id",
    [`${TAG}-${crypto.randomUUID()}@example.com`, firstName, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('Con-Zahler: ticket flag, toggling, and check-in asks for / books the payment', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const json = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });
    const admin = await makeUser('admin', 'Admin');
    const alice = await makeUser('mitglied', 'Alice');
    const bob = await makeUser('mitglied', 'Bob');
    const { rows: ev } = await query(`INSERT INTO events (name, event_date, is_active) VALUES ('${TAG} Con', '2099-08-01', true) RETURNING id`);
    const eventId = ev[0].id;
    const register = (user, body) => fetch(`${base}/events/${eventId}/register`, { method: 'POST', headers: json(user.cookie), body: JSON.stringify({ conRole: 'helfer', ...body }) });

    // Participants can't make themselves Con-Zahler (a sent flag is ignored).
    assert.equal((await register(alice, { conPayer: true })).status, 201);
    assert.equal((await register(bob, {})).status, 201);
    const mine = async (user) => (await (await fetch(`${base}/registrations`, { headers: json(user.cookie) })).json())[0];
    assert.equal((await mine(alice)).conPayer, false);

    // Only staff toggles it.
    const put = (user, target, conPayer) => fetch(`${base}/events/${eventId}/registrations/${target.userId}/con-payer`, { method: 'PUT', headers: json(user.cookie), body: JSON.stringify({ conPayer }) });
    assert.equal((await put(alice, alice, true)).status, 403);
    assert.equal((await put(admin, alice, 'yes')).status, 400);
    assert.equal((await put(admin, alice, true)).status, 200);
    assert.equal((await put(admin, bob, true)).status, 200);
    assert.equal((await mine(alice)).conPayer, true);

    // A pending Con-Zahler can be checked in (approved on the spot); the confirmed payment is booked.
    await query('UPDATE registrations SET amount_due_cents = 4000 WHERE event_id = $1', [eventId]);
    const checkin = (userId, body) => fetch(`${base}/events/${eventId}/checkin`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ userId, ...body }) });
    const scan = await (await fetch(`${base}/events/${eventId}/participants`, { headers: json(admin.cookie) })).json();
    assert.equal(scan.find((p) => p.userId === alice.userId).conPayer, true);
    assert.equal((await checkin(alice.userId, { paidConfirmed: true })).status, 200);
    const row = (await query('SELECT status, paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, alice.userId])).rows[0];
    assert.equal(row.status, 'checked_in');
    assert.ok(row.paid_at);
    assert.equal((await query('SELECT count(*)::int AS n FROM payments WHERE event_id = $1 AND user_id = $2', [eventId, alice.userId])).rows[0].n, 1);

    // Paid Con-Zahler can't be toggled any more; a normal pending person still can't check in.
    assert.equal((await put(admin, alice, false)).status, 409);
    await query("UPDATE registrations SET con_payer = false WHERE event_id = $1 AND user_id = $2", [eventId, bob.userId]);
    assert.equal((await checkin(bob.userId, {})).status, 409);
  });
});

test('unpaid reminders: up to the configured count, one mail per event, Con-Zahler and paid left out', async () => {
  const admin = await makeUser('admin', 'Rem');
  const a = await makeUser('mitglied', 'Anna');
  const b = await makeUser('mitglied', 'Berta');
  const c = await makeUser('mitglied', 'Clara');
  const { rows: ev } = await query(`INSERT INTO events (name, event_date, is_active) VALUES ('${TAG} Reminder', '2099-09-01', true) RETURNING id`);
  const eventId = ev[0].id;
  const insert = (user, extra) => query(
    `INSERT INTO registrations (user_id, event_id, con_role, status, amount_due_cents, pdf_import, created_at, ${extra.col}) VALUES ($1, $2, 'helfer', 'pending', 2500, true, now() - interval '10 days', ${extra.val})`,
    [user.userId, eventId]
  );
  await insert(a, { col: 'con_payer', val: 'false' });
  await insert(b, { col: 'con_payer', val: 'true' });
  await insert(c, { col: 'paid_at', val: 'now()' });
  await query('INSERT INTO app_settings DEFAULT VALUES').catch(() => {});
  await query("UPDATE app_settings SET unpaid_reminder_days = '{3,7}'");

  const sent = [];
  const send = async (to, payload) => { sent.push({ to, ...payload }); };
  // Nobody wants mail for other tests' leftovers: only look at our event.
  const mine = () => sent.filter((m) => m.eventName === `${TAG} Reminder`);

  await runUnpaidReminders({ send });
  assert.ok(mine().length >= 1);
  assert.ok(mine()[0].list.includes('Anna'));
  assert.ok(!mine()[0].list.includes('Berta') && !mine()[0].list.includes('Clara'));
  assert.equal(mine()[0].reminderNumber, 1);
  assert.equal((await query('SELECT unpaid_reminders_sent AS n FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, a.userId])).rows[0].n, 1);

  // Reminder 2 is due after 7 days (the registration is 10 days old), reminder 3 doesn't exist.
  sent.length = 0;
  await runUnpaidReminders({ send });
  assert.equal(mine()[0].reminderNumber, 2);
  sent.length = 0;
  await runUnpaidReminders({ send });
  assert.equal(mine().length, 0);
  assert.equal(admin.userId !== undefined, true);
});

test('Preisstufen can be marked Con-Zahler: validated, kept, and applied to the registration', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const json = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });
    const admin = await makeUser('admin', 'Stufen');
    const carl = await makeUser('mitglied', 'Carl');
    const dora = await makeUser('mitglied', 'Dora');
    // "Frühbucher" ran out long ago, so the registration falls into the open-ended tier.
    const pricing = (lastTierConPayer) => ({
      groups: ['Erwachsene'],
      tiers: [
        { name: 'Frühbucher', until: '2000-01-01', conPayer: false, amounts: { Erwachsene: 2000 } },
        { name: 'Vor Ort', until: null, conPayer: lastTierConPayer, amounts: { Erwachsene: 3500 } },
      ],
    });
    const create = (name, p) => fetch(`${base}/events`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ name: `${TAG} ${name}`, eventDate: '2099-08-01', pricing: p }) });
    assert.equal((await create('Falsch', pricing('ja'))).status, 400);

    const conPayerEvent = await (await create('Vor Ort', pricing(true))).json();
    const normalEvent = await (await create('Normal', pricing(false))).json();
    assert.equal(conPayerEvent.pricing.tiers.find((t) => t.name === 'Vor Ort').conPayer, true);
    await query('UPDATE events SET is_active = true WHERE id = ANY($1::uuid[])', [[conPayerEvent.id, normalEvent.id]]);

    const register = (user, event) => fetch(`${base}/events/${event.id}/register`, { method: 'POST', headers: json(user.cookie), body: JSON.stringify({ conRole: 'helfer', priceGroup: 'Erwachsene' }) });
    assert.equal((await register(carl, normalEvent)).status, 201);
    assert.equal((await register(dora, conPayerEvent)).status, 201);
    const conPayerOf = async (user, event) => (await query('SELECT con_payer, price_tier FROM registrations WHERE event_id = $1 AND user_id = $2', [event.id, user.userId])).rows[0];
    assert.deepEqual(await conPayerOf(carl, normalEvent), { con_payer: false, price_tier: 'Vor Ort' });
    assert.deepEqual(await conPayerOf(dora, conPayerEvent), { con_payer: true, price_tier: 'Vor Ort' });
  });
});

test('automation: after the last deadline unpaid registrations become Con-Zahler (re-priced); guests are mailed a week before each deadline', async () => {
  const account = await makeUser('mitglied', 'Konto');
  const paid = await makeUser('mitglied', 'Bezahlt');
  const guest = await makeUser('mitglied', 'Gast');
  await query('UPDATE users SET is_guest = true WHERE id = $1', [guest.userId]);
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const tiers = (until) => [
    { name: 'Früh', until, conPayer: false, amounts: { Erwachsene: 2000 } },
    { name: 'Vor Ort', until: null, conPayer: true, amounts: { Erwachsene: 3500 } },
  ];
  const mkEvent = async (name, until) => (await query(
    `INSERT INTO events (name, event_date, is_active, pricing) VALUES ($1, '2099-08-01', true, $2) RETURNING id`,
    [`${TAG} ${name}`, JSON.stringify({ groups: ['Erwachsene'], tiers: tiers(until) })]
  )).rows[0].id;
  const reg = (eventId, user, extra = '') => query(
    `INSERT INTO registrations (user_id, event_id, con_role, status, price_group, price_tier, price_list_cents, amount_due_cents, created_at ${extra ? ', ' + extra.col : ''})
     VALUES ($1, $2, 'helfer', 'pending', 'Erwachsene', 'Früh', 2000, 2500, now() - interval '60 days' ${extra ? ', ' + extra.val : ''})`,
    [user.userId, eventId]
  );
  const optIn = (eventId, user, token) => query('UPDATE registrations SET deadline_mail_optin = true, optout_token = $3 WHERE event_id = $1 AND user_id = $2', [eventId, user.userId, token]);

  // 1) The last dated tier ran out: unpaid -> Con-Zahler at the Con-Zahler price; paid stays untouched.
  const expired = await mkEvent('Abgelaufen', day(-1));
  await reg(expired, account);
  await reg(expired, paid, { col: 'paid_at', val: 'now()' });
  const sent = [];
  const send = async (to, payload) => { sent.push({ to, ...payload }); };
  await runConPayerAutomation({ send });
  const row = async (eventId, user) => (await query('SELECT con_payer, price_tier, price_list_cents, amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, user.userId])).rows[0];
  assert.deepEqual(await row(expired, account), { con_payer: true, price_tier: 'Vor Ort', price_list_cents: 3500, amount_due_cents: 4000 });
  assert.deepEqual(await row(expired, paid), { con_payer: false, price_tier: 'Früh', price_list_cents: 2000, amount_due_cents: 2500 });

  // 2) A deadline in 3 days: only those who opted in get a mail (once per deadline), each with an opt-out link.
  const soon = await mkEvent('Bald', day(3));
  await reg(soon, guest, { col: 'payment_token', val: `'tok-${TAG}'` });
  await reg(soon, account);
  await reg(soon, paid);
  await optIn(soon, guest, `out-guest-${TAG}`);
  await optIn(soon, account, `out-account-${TAG}`);
  await runConPayerAutomation({ send });
  await runConPayerAutomation({ send });
  const mine = sent.filter((m) => m.eventName === `${TAG} Bald`);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((m) => m.conPayerNext === true && m.deadline === day(3) && m.optoutUrl.includes('/deadline-optout.html?token=out-')));
  assert.ok(mine.some((m) => m.url.includes('/guest-payment.html?token=')));
  assert.ok(mine.some((m) => m.url.includes('/account.html')));
  assert.equal((await row(soon, guest)).con_payer, false);

  // Opt-out: the link works without login and the person is dropped from the list.
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/public/deadline-optout/out-account-${TAG}`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`http://localhost:${port}/public/deadline-optout/unknown`, { method: 'POST' })).status, 404);
  });
  assert.equal((await query('SELECT deadline_mail_optin FROM registrations WHERE event_id = $1 AND user_id = $2', [soon, account.userId])).rows[0].deadline_mail_optin, false);

  // 3) The deadline passes: the guest is marked Con-Zahler in the database as well.
  await query("UPDATE events SET pricing = $2 WHERE id = $1", [soon, JSON.stringify({ groups: ['Erwachsene'], tiers: tiers(day(-1)) })]);
  await runConPayerAutomation({ send });
  assert.equal((await row(soon, guest)).con_payer, true);
});

test.after(async () => {
  await query("DELETE FROM registrations WHERE event_id IN (SELECT id FROM events WHERE name LIKE $1)", [`${TAG}%`]);
  await query("DELETE FROM payments WHERE event_id IN (SELECT id FROM events WHERE name LIKE $1)", [`${TAG}%`]);
  await query("DELETE FROM events WHERE name LIKE $1", [`${TAG}%`]);
  await query("DELETE FROM users WHERE email LIKE $1", [`${TAG}-%`]);
  await query("UPDATE app_settings SET unpaid_reminder_days = '{}'");
  await closePool();
});
