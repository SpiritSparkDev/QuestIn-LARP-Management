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

after(async () => {
  // Leave app_settings and groups as other test files expect to find them.
  await query('UPDATE app_settings SET tavern_enabled = false');
  await query("UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'mitglied') WHERE group_id IN (SELECT id FROM groups WHERE key LIKE 'taverne\\_%')");
  await query("DELETE FROM groups WHERE key LIKE 'taverne\\_%'");
  await closePool();
});

async function makeUserAndSession(groupKey = 'mitglied', names = ['Taverne', 'Test']) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, $2, $3, (SELECT id FROM groups WHERE key = $4), true) RETURNING id",
    [`tavern-${groupKey}-${crypto.randomUUID()}@example.com`, names[0], names[1], groupKey]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

const json = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });

test('tavern: add-on switch and menu permission gate every staff route', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUserAndSession('admin');
    const member = await makeUserAndSession('mitglied');

    await query('UPDATE app_settings SET tavern_enabled = false');
    assert.equal((await fetch(`${base}/tavern/items`, { headers: json(admin.cookie) })).status, 404);

    const on = await fetch(`${base}/app-settings`, { method: 'PUT', headers: json(admin.cookie), body: JSON.stringify({ tavernEnabled: true }) });
    assert.equal((await on.json()).tavernEnabled, true);

    assert.equal((await fetch(`${base}/tavern/items`, { headers: json(admin.cookie) })).status, 200);
    assert.equal((await fetch(`${base}/tavern/items`, { headers: json(member.cookie) })).status, 403);

    // A group with the "taverne" menu gets access without being admin.
    const group = await fetch(`${base}/groups`, {
      method: 'POST', headers: json(admin.cookie),
      body: JSON.stringify({ key: `taverne_${Date.now()}`, name: 'Tavernenwirt', visibleMenus: ['konto', 'taverne'] }),
    });
    assert.equal(group.status, 201);
    const { id: groupId } = await group.json();
    await query('UPDATE users SET group_id = $1 WHERE id = $2', [groupId, member.userId]);
    assert.equal((await fetch(`${base}/tavern/items`, { headers: json(member.cookie) })).status, 200);
  });
});

test('tavern: accounts are numbered per event, searchable by number, OT and IT name, and not duplicated per person', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUserAndSession('admin');
    await query('UPDATE app_settings SET tavern_enabled = true');
    const guest = await makeUserAndSession('mitglied', ['Mara', 'Falk']);
    const { rows: ev } = await query("INSERT INTO events (name, event_date) VALUES ('Tavernen-Con', '2027-05-01') RETURNING id");
    const eventId = ev[0].id;
    await query("INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Laciel Nachtwind', '{}')", [guest.userId]);
    await query("INSERT INTO registrations (user_id, event_id, con_role, status) VALUES ($1, $2, 'helfer', 'confirmed')", [guest.userId, eventId]);

    const candidates = await (await fetch(`${base}/tavern/participants?eventId=${eventId}&q=laciel`, { headers: json(admin.cookie) })).json();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, 'Mara Falk');

    const created = await fetch(`${base}/tavern/accounts`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ eventId, userId: guest.userId }) });
    assert.equal(created.status, 201);
    const account = await created.json();
    assert.equal(account.number, 1);
    assert.equal(account.otName, 'Mara Falk');
    assert.deepEqual(account.characterNames, ['Laciel Nachtwind']);

    const again = await fetch(`${base}/tavern/accounts`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ eventId, userId: guest.userId }) });
    assert.equal(again.status, 409);

    const walkIn = await (await fetch(`${base}/tavern/accounts`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ eventId, label: 'Reisender Händler' }) })).json();
    assert.equal(walkIn.number, 2);

    const find = async (q) => (await (await fetch(`${base}/tavern/accounts?eventId=${eventId}&q=${encodeURIComponent(q)}`, { headers: json(admin.cookie) })).json()).map((a) => a.number);
    assert.deepEqual(await find('1'), [1]);
    assert.deepEqual(await find('falk'), [1]);
    assert.deepEqual(await find('nachtwind'), [1]);
    assert.deepEqual(await find('händler'), [2]);
    assert.deepEqual(await find(''), [1, 2]);
  });
});

test('tavern: top-up, charge at menu prices, lock, insufficient funds and storno keep the balance consistent', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUserAndSession('admin');
    await query('UPDATE app_settings SET tavern_enabled = true');
    const { rows: ev } = await query("INSERT INTO events (name, event_date) VALUES ('Kassen-Con', '2027-06-01') RETURNING id");
    const eventId = ev[0].id;
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify(body) });

    const beer = await (await post('/tavern/items', { name: 'Bier', category: 'Getränke', priceCents: 350 })).json();
    const mead = await (await post('/tavern/items', { name: 'Met', category: 'Getränke', priceCents: 450 })).json();
    assert.equal((await post('/tavern/items', { name: 'Kaputt', priceCents: -1 })).status, 400);

    const account = await (await post('/tavern/accounts', { eventId, label: 'Gast' })).json();
    const id = account.id;

    // Nothing to spend yet.
    const broke = await post(`/tavern/accounts/${id}/charge`, { items: [{ itemId: beer.id, quantity: 1 }] });
    assert.equal(broke.status, 409);
    assert.equal((await broke.json()).code, 'INSUFFICIENT_FUNDS');

    const topup = await post(`/tavern/accounts/${id}/topup`, { amountCents: 2000, method: 'cash' });
    assert.equal(topup.status, 201);
    assert.equal((await topup.json()).account.balanceCents, 2000);
    assert.equal((await post(`/tavern/accounts/${id}/topup`, { amountCents: 0, method: 'cash' })).status, 400);
    assert.equal((await post(`/tavern/accounts/${id}/topup`, { amountCents: 500, method: 'bitcoin' })).status, 400);

    // 2 x Bier + 1 x Met = 11,50 EUR, priced server-side.
    const charged = await post(`/tavern/accounts/${id}/charge`, { items: [{ itemId: beer.id, quantity: 2 }, { itemId: mead.id, quantity: 1 }] });
    assert.equal(charged.status, 201);
    const afterCharge = await charged.json();
    assert.equal(afterCharge.account.balanceCents, 850);
    const chargeEntry = afterCharge.transactions.find((t) => t.type === 'charge');
    assert.equal(chargeEntry.amountCents, -1150);

    // Price changes don't rewrite the booked entry.
    await fetch(`${base}/tavern/items/${beer.id}`, { method: 'PUT', headers: json(admin.cookie), body: JSON.stringify({ priceCents: 999 }) });
    const detail = await (await fetch(`${base}/tavern/accounts/${id}`, { headers: json(admin.cookie) })).json();
    assert.equal(detail.transactions.find((t) => t.id === chargeEntry.id).items[0].priceCents, 350);

    // More than the balance is refused and changes nothing.
    const tooMuch = await post(`/tavern/accounts/${id}/charge`, { customAmountCents: 5000, note: 'Fass' });
    assert.equal(tooMuch.status, 409);
    assert.equal((await (await fetch(`${base}/tavern/accounts/${id}`, { headers: json(admin.cookie) })).json()).account.balanceCents, 850);

    // Locked accounts can't be charged but can still be topped up.
    await fetch(`${base}/tavern/accounts/${id}/lock`, { method: 'PUT', headers: json(admin.cookie), body: JSON.stringify({ locked: true }) });
    const lockedCharge = await post(`/tavern/accounts/${id}/charge`, { customAmountCents: 100 });
    assert.equal((await lockedCharge.json()).code, 'ACCOUNT_LOCKED');
    assert.equal((await post(`/tavern/accounts/${id}/topup`, { amountCents: 100, method: 'card' })).status, 201);
    await fetch(`${base}/tavern/accounts/${id}/lock`, { method: 'PUT', headers: json(admin.cookie), body: JSON.stringify({ locked: false }) });

    // Storno of the drinks gives the money back, and only once.
    const voided = await post(`/tavern/transactions/${chargeEntry.id}/void`, {});
    assert.equal(voided.status, 200);
    assert.equal((await (await fetch(`${base}/tavern/accounts/${id}`, { headers: json(admin.cookie) })).json()).account.balanceCents, 950 + 1150);
    assert.equal((await post(`/tavern/transactions/${chargeEntry.id}/void`, {})).status, 409);

    // Parallel charges can't overdraw: balance 2100, five charges of 500 -> exactly four succeed.
    const results = await Promise.all(Array.from({ length: 5 }, () => post(`/tavern/accounts/${id}/charge`, { customAmountCents: 500, note: 'Parallel' })));
    assert.equal(results.filter((r) => r.status === 201).length, 4);
    assert.equal((await (await fetch(`${base}/tavern/accounts/${id}`, { headers: json(admin.cookie) })).json()).account.balanceCents, 100);
  });
});

test('tavern: a participant can look up their own balance', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const admin = await makeUserAndSession('admin');
    const guest = await makeUserAndSession('mitglied');
    await query('UPDATE app_settings SET tavern_enabled = true');
    const { rows: ev } = await query("INSERT INTO events (name, event_date) VALUES ('Eigenes-Guthaben', '2027-07-01') RETURNING id");
    const account = await (await fetch(`${base}/tavern/accounts`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ eventId: ev[0].id, userId: guest.userId }) })).json();
    await fetch(`${base}/tavern/accounts/${account.id}/topup`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ amountCents: 1234, method: 'paypal' }) });
    const mine = await (await fetch(`${base}/tavern/my-balance`, { headers: json(guest.cookie) })).json();
    assert.equal(mine[0].balanceCents, 1234);
    assert.equal(mine[0].number, account.number);
  });
});
