import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createServer } = await import('../../backend/server.js');
const { setPaymentSettings } = await import('../../backend/paymentSettings/repository.js');

const tag = crypto.randomUUID().slice(0, 8);

async function makeUser(firstName, { managedBy = null, parent = null, groupName = null } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, email_verified, managed_by_user_id, group_parent_id, group_name)
     VALUES ($1, $2, 'Gruppe', (SELECT id FROM groups WHERE key = 'mitglied'), true, $3, $4, $5) RETURNING id`,
    [`group-payment-${tag}-${crypto.randomUUID()}@example.com`, firstName, managedBy, parent, groupName]
  );
  return rows[0].id;
}

async function makeEvent(paymentsOpen = true) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active, payments_open, code) VALUES ('Group Pay Con', '2027-08-01', true, $1, 'GP1/2027') RETURNING id",
    [paymentsOpen]
  );
  return rows[0].id;
}

async function register(eventId, userId, { cents = 5000, paid = false, conPayer = false } = {}) {
  await query(
    `INSERT INTO registrations (user_id, event_id, con_role, status, amount_due_cents, paid_at, con_payer)
     VALUES ($1, $2, 'helfer', 'confirmed', $3, $4, $5)`,
    [userId, eventId, cents, paid ? new Date() : null, conPayer]
  );
}

async function setup({ paymentsOpen = true } = {}) {
  await setPaymentSettings({ bankIban: 'DE02100100100006820101', bankBic: 'PBNKDEFF', bankAccountHolder: 'Pakyrion e.V.', bankEnabled: true, bankGroupReferenceTemplate: '' });
  const payer = await makeUser('Boss', { groupName: 'Drachenbande' });
  const child = await makeUser('Lena', { managedBy: payer });
  const sub = await makeUser('Tom', { parent: payer });
  const stranger = await makeUser('Fremd');
  const eventId = await makeEvent(paymentsOpen);
  for (const id of [child, sub, stranger]) await register(eventId, id);
  const cookie = `session=${(await createSession(payer)).token}`;
  return { payer, child, sub, stranger, eventId, cookie };
}

async function withServer(fn) {
  const server = createServer().listen(0);
  try {
    const base = `http://localhost:${server.address().port}`;
    await fn((path, cookie, body) => fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  } finally {
    server.close();
  }
}

test('GET lists managed and sub-group persons with an open amount, not strangers', async () => {
  const s = await setup();
  await withServer(async (call) => {
    const res = await call(`/events/${s.eventId}/group-payment`, s.cookie);
    assert.equal(res.status, 200);
    const { payable } = await res.json();
    assert.deepEqual(payable.map((p) => p.userId).sort(), [s.child, s.sub].sort());
    assert.equal(payable[0].amountDueCents, 5000);
    assert.equal(payable[0].transferNotifiedAt, null);
    assert.ok(payable[0].name);
  });
});

test('GET hides paid and Con-Zahler persons and is empty when payments are not open', async () => {
  const s = await setup();
  await query('UPDATE registrations SET paid_at = now() WHERE event_id = $1 AND user_id = $2', [s.eventId, s.child]);
  await query('UPDATE registrations SET con_payer = true WHERE event_id = $1 AND user_id = $2', [s.eventId, s.sub]);
  await withServer(async (call) => {
    assert.deepEqual((await (await call(`/events/${s.eventId}/group-payment`, s.cookie)).json()).payable, []);
  });
  const closed = await setup({ paymentsOpen: false });
  await withServer(async (call) => {
    assert.deepEqual((await (await call(`/events/${closed.eventId}/group-payment`, closed.cookie)).json()).payable, []);
  });
});

test('POST bank returns total, persons and a group reference', async () => {
  const s = await setup();
  await withServer(async (call) => {
    const res = await call(`/events/${s.eventId}/group-payment/bank`, s.cookie, { userIds: [s.child, s.sub] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalCents, 10000);
    assert.equal(body.persons.length, 2);
    assert.equal(body.bank.iban, 'DE02100100100006820101');
    assert.equal(body.bank.accountHolder, 'Pakyrion e.V.');
    assert.equal(body.bank.reference, 'GP1/2027 Boss-Gruppe: Lena, Tom');
  });
});

test('POST validates input, ownership and payability', async () => {
  const s = await setup();
  await withServer(async (call) => {
    const bank = `/events/${s.eventId}/group-payment/bank`;
    assert.equal((await call(bank, s.cookie, { userIds: [] })).status, 400);
    assert.equal((await call(bank, s.cookie, { userIds: ['nope'] })).status, 400);
    assert.equal((await call(bank, s.cookie, { userIds: Array.from({ length: 101 }, () => crypto.randomUUID()) })).status, 400);
    assert.equal((await call(bank, s.cookie, { userIds: [s.child, s.stranger] })).status, 403);

    await query('UPDATE registrations SET paid_at = now() WHERE event_id = $1 AND user_id = $2', [s.eventId, s.child]);
    assert.equal((await call(bank, s.cookie, { userIds: [s.child] })).status, 409);
    await query('UPDATE registrations SET con_payer = true WHERE event_id = $1 AND user_id = $2', [s.eventId, s.sub]);
    assert.equal((await call(bank, s.cookie, { userIds: [s.sub] })).status, 409);
  });
  const closed = await setup({ paymentsOpen: false });
  await withServer(async (call) => {
    assert.equal((await call(`/events/${closed.eventId}/group-payment/bank`, closed.cookie, { userIds: [closed.child] })).status, 409);
  });
});

test('POST bank answers 409 when no bank is live', async () => {
  const s = await setup();
  await setPaymentSettings({ bankEnabled: false });
  await withServer(async (call) => {
    assert.equal((await call(`/events/${s.eventId}/group-payment/bank`, s.cookie, { userIds: [s.child] })).status, 409);
  });
});

test('POST transfer-notice marks every selected person and checks ownership', async () => {
  const s = await setup();
  await withServer(async (call) => {
    const path = `/events/${s.eventId}/group-payment/transfer-notice`;
    assert.equal((await call(path, s.cookie, { userIds: [s.child, s.stranger] })).status, 403);
    const res = await call(path, s.cookie, { userIds: [s.child, s.sub] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { notified: 2 });
    const { rows } = await query('SELECT count(*)::int AS n FROM registrations WHERE event_id = $1 AND transfer_notified_at IS NOT NULL', [s.eventId]);
    assert.equal(rows[0].n, 2);
    const list = (await (await call(`/events/${s.eventId}/group-payment`, s.cookie)).json()).payable;
    assert.ok(list.every((p) => p.transferNotifiedAt));
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE $1", [`group-payment-${tag}-%`]);
  await query("DELETE FROM events WHERE name = 'Group Pay Con'");
  await closePool();
});
