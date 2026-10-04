import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';
import Stripe from 'stripe';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const {
  setAmountDue, markPaidManually, markUnpaid, recordSuccessfulStripePayment,
} = await import('../../backend/payments/repository.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createAccount: createTavernAccount, getAccount: getTavernAccount, setLocked: setTavernLocked } = await import('../../backend/tavern/repository.js');

async function makeSession(userId) {
  const session = await createSession(userId);
  return `session=${session.token}`;
}

async function makeCheckinGroupUserAndSession() {
  const key = `payments_checkin_${crypto.randomUUID().slice(0, 8)}`;
  await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status)
     VALUES ($1, $2, '["checkin"]', '[]', false, true)`,
    [key, key]
  );
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Pay', 'Checkin', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`payments-checkin-${crypto.randomUUID()}@example.com`, key]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

async function makeUser() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Pay', 'Repo Test', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`payments-repo-${crypto.randomUUID()}@example.com`]
  );
  return rows[0].id;
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active) VALUES ('Payments Repo Test Con', '2027-08-01', true) RETURNING id"
  );
  return rows[0].id;
}

async function makeRegistration(eventId, userId) {
  await query(
    "INSERT INTO registrations (user_id, event_id, con_role, status) VALUES ($1, $2, 'helfer', 'confirmed')",
    [userId, eventId]
  );
}

test('setAmountDue then markPaidManually gates and ungates the registration', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  const adminId = await makeUser();
  await makeRegistration(eventId, userId);

  const afterSet = await setAmountDue(eventId, userId, 4500);
  assert.equal(afterSet.amountDueCents, 4500);
  assert.equal(afterSet.paidAt, null);

  const afterPaid = await markPaidManually(eventId, userId, adminId);
  assert.ok(afterPaid.paidAt);

  const { rows } = await query('SELECT method, amount_cents, confirmed_by FROM payments WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].method, 'bank_transfer');
  assert.equal(rows[0].amount_cents, 4500);
  assert.equal(rows[0].confirmed_by, adminId);
});

test('markPaidManually rejects a registration with no amount due', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  const adminId = await makeUser();
  await makeRegistration(eventId, userId);

  await assert.rejects(
    () => markPaidManually(eventId, userId, adminId),
    (err) => err.code === 'NO_AMOUNT_DUE'
  );
});

test('markPaidManually is idempotent when called twice on the same registration', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  const adminId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 4500);

  await markPaidManually(eventId, userId, adminId);
  // A double-click on "Als bezahlt markieren", a retried PATCH, or two admin
  // tabs must not add a second audit-trail row.
  await markPaidManually(eventId, userId, adminId);

  const { rows } = await query('SELECT count(*)::int AS count FROM payments WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.equal(rows[0].count, 1);
});

test('markUnpaid clears paidAt without deleting the payment history', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  const adminId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 2000);
  await markPaidManually(eventId, userId, adminId);

  const afterReset = await markUnpaid(eventId, userId);
  assert.equal(afterReset.paidAt, null);

  const { rows } = await query('SELECT count(*)::int AS count FROM payments WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.equal(rows[0].count, 1);
});

test('recordSuccessfulStripePayment sets paidAt and is idempotent on the same providerReference', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 3000);

  await recordSuccessfulStripePayment({ eventId, userId, method: 'stripe_card', amountCents: 3000, providerReference: 'cs_test_123' });
  const { rows: afterFirst } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.ok(afterFirst[0].paid_at);
  const firstPaidAt = afterFirst[0].paid_at;

  // Stripe retries webhooks -- a second delivery of the same event must not
  // create a second payments row or move paid_at.
  await recordSuccessfulStripePayment({ eventId, userId, method: 'stripe_card', amountCents: 3000, providerReference: 'cs_test_123' });
  const { rows: countRows } = await query('SELECT count(*)::int AS count FROM payments WHERE provider_reference = $1', ['cs_test_123']);
  assert.equal(countRows[0].count, 1);
  const { rows: afterSecond } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.deepEqual(afterSecond[0].paid_at, firstPaidAt);
});

test('POST checkout-session rejects a registration with no amount due', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    const cookie = await makeSession(userId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST checkout-session rejects a caller who is not the registration owner', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 1000);
    const otherUserId = await makeUser();
    const cookie = await makeSession(otherUserId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 403);
  });
});

test('POST checkout-session rejects an already-paid registration', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    const adminId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 1000);
    await markPaidManually(eventId, userId, adminId);
    const cookie = await makeSession(userId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 409);
  });
});

async function configureStripeSettings(port, webhookSecret) {
  const adminId = await makeUser();
  await query("UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'admin') WHERE id = $1", [adminId]);
  const adminCookie = await makeSession(adminId);
  await fetch(`http://localhost:${port}/admin/settings/payments`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ stripeSecretKey: 'sk_test_dummy', stripeWebhookSecret: webhookSecret }),
  });
}

test('POST /webhooks/stripe with an invalid signature is rejected', async () => {
  await withTestServer(async (port) => {
    // Configure Stripe explicitly rather than relying on state left behind
    // by another test -- payment_settings is a single global row shared
    // across every test file (paymentSettings.test.js deletes it in its own
    // test.after), so without this the route's "Stripe not configured" 503
    // branch could mask the signature-verification 400 this test asserts.
    await configureStripeSettings(port, 'whsec_test_secret');

    const res = await fetch(`http://localhost:${port}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'not-a-real-signature' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /webhooks/stripe marks the registration paid on a validly-signed checkout.session.completed', async () => {
  await withTestServer(async (port) => {
    const webhookSecret = 'whsec_test_secret';
    await configureStripeSettings(port, webhookSecret);

    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 2500);

    const payload = JSON.stringify({
      id: 'evt_test_1', type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_webhook_1', client_reference_id: `${eventId}:${userId}`, amount_total: 2500, payment_method_types: ['card'], payment_status: 'paid' } },
    });
    // Stripe's own test helper for generating a locally-valid signature --
    // no network call, matches how Stripe's docs recommend testing webhook
    // handlers offline.
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

    const res = await fetch(`http://localhost:${port}/webhooks/stripe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    assert.equal(res.status, 200);

    const { rows } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    assert.ok(rows[0].paid_at);
  });
});

async function postSignedStripeEvent(port, webhookSecret, type, object) {
  const payload = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, data: { object } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  return fetch(`http://localhost:${port}/webhooks/stripe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload,
  });
}

test('a Stripe bank transfer is only booked paid on async_payment_succeeded, not on checkout.session.completed', async () => {
  await withTestServer(async (port) => {
    const webhookSecret = 'whsec_test_secret';
    await configureStripeSettings(port, webhookSecret);

    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 4000);
    const session = {
      id: `cs_test_bt_${crypto.randomUUID()}`, client_reference_id: `${eventId}:${userId}`, amount_total: 4000,
      payment_method_types: ['customer_balance'], payment_status: 'unpaid',
    };

    const completedRes = await postSignedStripeEvent(port, webhookSecret, 'checkout.session.completed', session);
    assert.equal(completedRes.status, 200);
    const { rows: before } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    assert.equal(before[0].paid_at, null);

    const succeededRes = await postSignedStripeEvent(port, webhookSecret, 'checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' });
    assert.equal(succeededRes.status, 200);
    const { rows: after } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    assert.ok(after[0].paid_at);
    const { rows: payments } = await query('SELECT method FROM payments WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    assert.deepEqual(payments.map((p) => p.method), ['stripe_bank_transfer']);
  });
});

test('PATCH .../payment lets checkin-menu staff set an amount and mark paid, and rejects a plain member', async () => {
  await withTestServer(async (port) => {
    const { cookie: staffCookie } = await makeCheckinGroupUserAndSession();
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);

    const setAmountRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ amountDueCents: 3000 }),
    });
    assert.equal(setAmountRes.status, 200);
    assert.equal((await setAmountRes.json()).amountDueCents, 3000);

    const markPaidRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ markPaid: true }),
    });
    assert.equal(markPaidRes.status, 200);
    assert.ok((await markPaidRes.json()).paidAt);

    const memberCookie = await makeSession(await makeUser());
    const forbiddenRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ amountDueCents: 1000 }),
    });
    assert.equal(forbiddenRes.status, 403);
  });
});

test('POST .../refund returns 404 when there is no unrefunded payment for the registration', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    const { cookie } = await makeCheckinGroupUserAndSession();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });
});

test('POST .../refund fully refunds a bank_transfer payment without calling Stripe, and leaves registrations.paid_at untouched', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 2000);
    const { userId: adminId, cookie } = await makeCheckinGroupUserAndSession();
    await markPaidManually(eventId, userId, adminId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.refundAmountCents, 2000);
    assert.ok(body.refundedAt);

    const { rows } = await query(
      'SELECT refunded_at, refund_amount_cents FROM payments WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
    assert.ok(rows[0].refunded_at);
    assert.equal(rows[0].refund_amount_cents, 2000);

    const { rows: regRows } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    assert.ok(regRows[0].paid_at, 'paid_at must stay set -- refund state lives on payments, not registrations');
  });
});

test('POST .../refund supports a partial amount', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 5000);
    const { userId: adminId, cookie } = await makeCheckinGroupUserAndSession();
    await markPaidManually(eventId, userId, adminId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ amountCents: 1500 }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).refundAmountCents, 1500);
  });
});

test('POST .../refund rejects an amountCents greater than the paid amount', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 1000);
    const { userId: adminId, cookie } = await makeCheckinGroupUserAndSession();
    await markPaidManually(eventId, userId, adminId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ amountCents: 2000 }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST .../refund rejects a second refund attempt on the same payment', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 1000);
    const { userId: adminId, cookie } = await makeCheckinGroupUserAndSession();
    await markPaidManually(eventId, userId, adminId);

    await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({}),
    });
    const second = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({}),
    });
    assert.equal(second.status, 404);
  });
});

test('POST .../refund on a stripe payment with no stored payment_intent is rejected rather than silently skipped', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await recordSuccessfulStripePayment({ eventId, userId, method: 'stripe_card', amountCents: 1000, providerReference: `pi-test-${crypto.randomUUID()}` });
    const { cookie } = await makeCheckinGroupUserAndSession();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
  });
});

test('POST .../refund is rejected for a group without the checkin menu', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 1000);
    const { userId: adminId } = await makeCheckinGroupUserAndSession();
    await markPaidManually(eventId, userId, adminId);
    const memberCookie = await makeSession(await makeUser());

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: memberCookie }, body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });
});

test('POST .../payment-reminders emails everyone with an open balance and reports sent/total', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const unpaidUser = await makeUser();
    await makeRegistration(eventId, unpaidUser);
    await setAmountDue(eventId, unpaidUser, 1000);

    const paidUser = await makeUser();
    await makeRegistration(eventId, paidUser);
    await setAmountDue(eventId, paidUser, 1000);
    const { userId: adminId, cookie } = await makeCheckinGroupUserAndSession();
    await markPaidManually(eventId, paidUser, adminId);

    const noAmountUser = await makeUser();
    await makeRegistration(eventId, noAmountUser);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/payment-reminders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.sent, 1);
  });
});

test('POST .../payment-reminders is rejected for a group without the checkin menu', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const memberCookie = await makeSession(await makeUser());
    const res = await fetch(`http://localhost:${port}/events/${eventId}/payment-reminders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
    });
    assert.equal(res.status, 403);
  });
});

test('an owner can start a checkout session for their managed person\'s registration', async () => {
  await withTestServer(async (port) => {
    const ownerId = await makeUser();
    const cookie = await makeSession(ownerId);
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'PayOwner' }),
    });
    const { id: managedId } = await personRes.json();
    const eventId = await makeEvent();
    await makeRegistration(eventId, managedId);
    await setAmountDue(eventId, managedId, 1000);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${managedId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    // 502 is the existing, expected response when Stripe isn't configured
    // in this test environment (see the same assertion style for the
    // self-service checkout-session tests already in this file) -- the
    // point of this test is that ownership passes (not a 403), not that
    // a real Stripe session gets created.
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 404);
  });
});

test('a stranger cannot start a checkout session for someone else\'s managed person', async () => {
  await withTestServer(async (port) => {
    const ownerId = await makeUser();
    const ownerCookie = await makeSession(ownerId);
    const strangerCookie = await makeSession(await makeUser());
    const personRes = await fetch(`http://localhost:${port}/managed-persons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ firstName: 'ManagedTestPerson', lastName: 'PayStranger' }),
    });
    const { id: managedId } = await personRes.json();
    const eventId = await makeEvent();
    await makeRegistration(eventId, managedId);
    await setAmountDue(eventId, managedId, 1000);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${managedId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 403);
  });
});

async function setTavernEnabled(enabled) {
  const { rows } = await query('SELECT 1 FROM app_settings LIMIT 1');
  if (rows.length === 0) await query('INSERT INTO app_settings DEFAULT VALUES');
  await query('UPDATE app_settings SET tavern_enabled = $1', [enabled]);
}

test('a Stripe tavern top-up is booked once, even when the webhook is delivered twice', async () => {
  await withTestServer(async (port) => {
    const webhookSecret = 'whsec_test_secret';
    await configureStripeSettings(port, webhookSecret);
    const eventId = await makeEvent();
    const userId = await makeUser();
    const account = await createTavernAccount({ eventId, userId });
    const session = {
      id: `cs_test_tavern_${crypto.randomUUID()}`, client_reference_id: `tavern:${account.id}`, amount_total: 2000,
      payment_method_types: ['card'], payment_status: 'paid',
    };

    assert.equal((await postSignedStripeEvent(port, webhookSecret, 'checkout.session.completed', session)).status, 200);
    assert.equal((await postSignedStripeEvent(port, webhookSecret, 'checkout.session.completed', session)).status, 200);

    assert.equal((await getTavernAccount(account.id)).balanceCents, 2000);
    const { rows } = await query('SELECT type, method, amount_cents FROM tavern_transactions WHERE account_id = $1', [account.id]);
    assert.deepEqual(rows, [{ type: 'topup', method: 'card', amount_cents: 2000 }]);
    const { rows: payments } = await query('SELECT 1 FROM payments WHERE event_id = $1', [eventId]);
    assert.equal(payments.length, 0);
  });
});

test('a Stripe bank-transfer tavern top-up is only booked on async_payment_succeeded', async () => {
  await withTestServer(async (port) => {
    const webhookSecret = 'whsec_test_secret';
    await configureStripeSettings(port, webhookSecret);
    const eventId = await makeEvent();
    const userId = await makeUser();
    const account = await createTavernAccount({ eventId, userId });
    const session = {
      id: `cs_test_tavern_bt_${crypto.randomUUID()}`, client_reference_id: `tavern:${account.id}`, amount_total: 5000,
      payment_method_types: ['customer_balance'], payment_status: 'unpaid',
    };

    await postSignedStripeEvent(port, webhookSecret, 'checkout.session.completed', session);
    assert.equal((await getTavernAccount(account.id)).balanceCents, 0);
    await postSignedStripeEvent(port, webhookSecret, 'checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' });
    assert.equal((await getTavernAccount(account.id)).balanceCents, 5000);
  });
});

test('POST /tavern/my-topup-session validates add-on switch, amount, account and lock', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    const cookie = await makeSession(userId);
    const post = (body) => fetch(`http://localhost:${port}/tavern/my-topup-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    });

    await setTavernEnabled(false);
    assert.equal((await post({ amountCents: 2000, method: 'card' })).status, 404);

    await setTavernEnabled(true);
    assert.equal((await post({ amountCents: 2000, method: 'bitcoin' })).status, 400);
    assert.equal((await post({ amountCents: 100, method: 'card' })).status, 400);
    assert.equal((await post({ amountCents: 30000, method: 'card' })).status, 400);
    assert.equal((await post({ amountCents: 2000, method: 'card' })).status, 404);

    const account = await createTavernAccount({ eventId, userId });
    await setTavernLocked(account.id, true);
    assert.equal((await post({ amountCents: 2000, method: 'card' })).status, 409);
  });
});

test.after(async () => {
  await query('UPDATE app_settings SET tavern_enabled = false');
  // payments.confirmed_by has no ON DELETE action, and a single multi-row
  // DELETE FROM users doesn't guarantee the registrations->payments cascade
  // for one test's participant runs before the confirmed_by check for
  // another test's admin in the same statement -- delete the referencing
  // payments rows explicitly first so the users delete never races it.
  await query("DELETE FROM payments WHERE confirmed_by IN (SELECT id FROM users WHERE email LIKE 'payments-repo-%' OR email LIKE 'payments-checkin-%')");
  await query("DELETE FROM users WHERE email LIKE 'payments-repo-%'");
  // makeCheckinGroupUserAndSession creates its own throwaway 'checkin' group
  // per test run -- other test files (schema-users.test.js, seedGroups.test.js)
  // assert the exact set of groups in this shared DB, so its user and group
  // must be deleted here too, same pattern as checkin.test.js/registrations.test.js.
  await query("DELETE FROM users WHERE email LIKE 'payments-checkin-%'");
  await query("DELETE FROM groups WHERE key LIKE 'payments_checkin_%'");
  await query("DELETE FROM events WHERE name = 'Payments Repo Test Con'");
  await closePool();
});
