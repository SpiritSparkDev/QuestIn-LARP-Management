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
    "INSERT INTO events (name, event_date, is_active, payments_open) VALUES ('Payments Repo Test Con', '2027-08-01', true, true) RETURNING id"
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

test('POST checkout-session is refused while the event has payments_open off', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    await query('UPDATE events SET payments_open = false WHERE id = $1', [eventId]);
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 1000);
    const cookie = await makeSession(userId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 409);
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
      data: { object: { id: 'cs_test_webhook_1', client_reference_id: `${eventId}:${userId}`, amount_total: 2500, currency: 'eur', payment_method_types: ['card'], payment_status: 'paid' } },
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
      id: `cs_test_bt_${crypto.randomUUID()}`, client_reference_id: `${eventId}:${userId}`, amount_total: 4000, currency: 'eur',
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

test('POST /webhooks/stripe does not mark paid when the session paid less than is due now', async () => {
  await withTestServer(async (port) => {
    await configureStripeSettings(port, 'whsec_test_secret');
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 5000); // grew after the session (e.g. extras) was created
    const res = await postSignedStripeEvent(port, 'whsec_test_secret', 'checkout.session.completed', {
      id: `cs_test_low_${crypto.randomUUID()}`, client_reference_id: `${eventId}:${userId}`, amount_total: 4000, currency: 'eur',
      payment_method_types: ['card'], payment_status: 'paid',
    });
    assert.equal(res.status, 200);
    const { rows } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    assert.equal(rows[0].paid_at, null);
  });
});

test('tavern top-up refuses methods the tavern ledger does not know (SumUp, direct PayPal, Klarna)', async () => {
  await withTestServer(async (port) => {
    await query('UPDATE app_settings SET tavern_enabled = true');
    const userId = await makeUser();
    const res = await fetch(`http://localhost:${port}/tavern/my-topup-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await makeSession(userId) },
      body: JSON.stringify({ method: 'sumup', amountCents: 1000 }),
    });
    assert.equal(res.status, 400);
    for (const method of ['paypal_direct', 'klarna', 'sepa_debit']) {
      const other = await fetch(`http://localhost:${port}/tavern/my-topup-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await makeSession(userId) },
        body: JSON.stringify({ method, amountCents: 1000 }),
      });
      assert.equal(other.status, 400, method);
    }
  });
});

test('POST transfer-notice flags an open registration, is idempotent, refuses strangers and paid registrations', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 3000);
    const strangerId = await makeUser();
    const post = (cookie) => fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/transfer-notice`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });

    assert.equal((await post(await makeSession(strangerId))).status, 403);
    const own = await makeSession(userId);
    assert.equal((await post(own)).status, 200);
    const first = (await query('SELECT transfer_notified_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0].transfer_notified_at;
    assert.ok(first);
    assert.equal((await post(own)).status, 200);
    const again = (await query('SELECT transfer_notified_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0].transfer_notified_at;
    assert.equal(again.getTime(), first.getTime());
    assert.equal((await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0].paid_at, null);

    await query('UPDATE registrations SET paid_at = now() WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    assert.equal((await post(own)).status, 409);
  });
});

test('POST checkout-session refuses a Stripe method the admin has not switched on', async () => {
  await withTestServer(async (port) => {
    const { setPaymentSettings } = await import('../../backend/paymentSettings/repository.js');
    await setPaymentSettings({ stripeSecretKey: 'sk_test_unused', stripeEnabled: true, stripeMethods: ['card'] });
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 2000);
    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await makeSession(userId) },
      body: JSON.stringify({ method: 'klarna' }),
    });
    assert.equal(res.status, 502); // "not configured" -- nothing was sent to Stripe
  });
  await query("UPDATE payment_settings SET stripe_methods = '{card,paypal,bank_transfer}'");
});

test('PayPal order asks for the PayPal login first and sends the exact amount in EUR', async () => {
  const { createPaypalOrder } = await import('../../backend/payments/paypalClient.js');
  const realFetch = globalThis.fetch;
  let orderBody;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.includes('/v1/oauth2/token')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }));
    if (u.endsWith('/v2/checkout/orders')) {
      orderBody = JSON.parse(init.body);
      return Promise.resolve(new Response(JSON.stringify({ id: 'ORDER12345', links: [{ rel: 'payer-action', href: 'https://paypal.example/approve' }] }), { status: 201 }));
    }
    return realFetch(url, init);
  };
  try {
    const out = await createPaypalOrder(
      { clientId: 'c', secret: 's', base: 'https://api-m.sandbox.paypal.com' },
      { reference: 'e:u', amountCents: 4550, description: 'Teilnahmegebühr', returnUrl: 'https://app.test/paypal/return', cancelUrl: 'https://app.test/paypal/cancel', requestId: 'req-1' },
    );
    assert.equal(out.approveUrl, 'https://paypal.example/approve');
    assert.equal(orderBody.purchase_units[0].amount.value, '45.50');
    assert.equal(orderBody.purchase_units[0].amount.currency_code, 'EUR');
    assert.equal(orderBody.payment_source.paypal.experience_context.landing_page, 'LOGIN');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PayPal return: books only a COMPLETED capture of this registration that covers the due amount, once', async () => {
  const { setPaymentSettings } = await import('../../backend/paymentSettings/repository.js');
  await setPaymentSettings({ paypalClientId: 'cid', paypalSecret: 'secret', paypalEnabled: true });
  const eventId = await makeEvent();
  const userId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 4500);
  const mkOrder = async (id) => query(
    "INSERT INTO paypal_orders (order_id, event_id, user_id, amount_cents, success_url, cancel_url) VALUES ($1, $2, $3, 4500, 'http://app.test/ok', 'http://app.test/no')",
    [id, eventId, userId]
  );
  const completed = (over = {}) => ({
    status: 'COMPLETED',
    purchase_units: [{ custom_id: `${eventId}:${userId}`, payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '45.00' } }] } }],
    ...over,
  });

  const realFetch = globalThis.fetch;
  let order;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.includes('paypal.com/v1/oauth2/token')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }));
    if (u.includes('paypal.com/v2/checkout/orders')) return Promise.resolve(new Response(JSON.stringify(order), { status: 200 }));
    return realFetch(url, init);
  };
  try {
    await withTestServer(async (port) => {
      const ret = (token) => realFetch(`http://localhost:${port}/paypal/return?token=${token}`, { redirect: 'manual' });
      const paid = async () => (await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0].paid_at;

      // unknown / malformed token: nothing happens
      assert.equal((await ret('UNKNOWNORDER1')).status, 302);
      assert.equal((await ret('bad token!')).status, 302);

      const cases = [
        ['PENDINGORDER1', completed({ status: 'APPROVED' })],
        ['WRONGREFORD1', completed({ purchase_units: [{ custom_id: 'someone:else', payments: { captures: [{ id: 'C', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '45.00' } }] } }] })],
        ['LOWAMOUNTORD', completed({ purchase_units: [{ custom_id: `${eventId}:${userId}`, payments: { captures: [{ id: 'C', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '10.00' } }] } }] })],
        ['WRONGCURRORD', completed({ purchase_units: [{ custom_id: `${eventId}:${userId}`, payments: { captures: [{ id: 'C', status: 'COMPLETED', amount: { currency_code: 'USD', value: '45.00' } }] } }] })],
      ];
      for (const [id, body] of cases) {
        await mkOrder(id);
        order = body;
        const res = await ret(id);
        assert.equal(res.headers.get('location'), 'http://app.test/no', id);
        assert.equal(await paid(), null, `must not book ${id}`);
      }

      await mkOrder('GOODORDER123');
      order = completed();
      const ok = await ret('GOODORDER123');
      assert.equal(ok.headers.get('location'), 'http://app.test/ok');
      assert.notEqual(await paid(), null);
      assert.equal((await ret('GOODORDER123')).headers.get('location'), 'http://app.test/ok'); // idempotent
      const { rows } = await query('SELECT method FROM payments WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
      assert.deepEqual(rows.map((r) => r.method), ['paypal']);
    });
  } finally {
    globalThis.fetch = realFetch;
    await query('UPDATE payment_settings SET paypal_client_id = NULL, paypal_secret_enc = NULL, stripe_secret_key_enc = NULL');
  }
});

test('guest checkout "auto" says so when no online method is set up, and still validates the method', async () => {
  const { setGuestPaymentToken } = await import('../../backend/payments/repository.js');
  await query('UPDATE payment_settings SET stripe_secret_key_enc = NULL, paypal_client_id = NULL, paypal_secret_enc = NULL, sumup_api_key_enc = NULL');
  const eventId = await makeEvent();
  const userId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 2000);
  const { token } = await setGuestPaymentToken(eventId, userId, 60_000);
  await withTestServer(async (port) => {
    const post = (method) => fetch(`http://localhost:${port}/public/registrations/${token}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method }),
    });
    assert.equal((await post('auto')).status, 409);
    assert.equal((await post('bitcoin')).status, 400);
  });
});

test('guest page: without an online method it still gets the bank data, can report a transfer, and the hint names the contact address', async () => {
  const { setPaymentSettings } = await import('../../backend/paymentSettings/repository.js');
  const { setGuestPaymentToken } = await import('../../backend/payments/repository.js');
  await query('UPDATE payment_settings SET stripe_secret_key_enc = NULL, paypal_client_id = NULL, paypal_secret_enc = NULL, sumup_api_key_enc = NULL');
  await setPaymentSettings({ bankIban: 'DE02100100100006820101', bankBic: 'PBNKDEFF', bankAccountHolder: 'Pakyrion e.V.', bankEnabled: true, contactEmail: 'orga@example.com' });
  const eventId = await makeEvent();
  await query("UPDATE events SET code = 'T17/2027' WHERE id = $1", [eventId]);
  const userId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 2000);
  const { token } = await setGuestPaymentToken(eventId, userId, 60_000);
  await withTestServer(async (port) => {
    const info = await (await fetch(`http://localhost:${port}/public/registrations/${token}`)).json();
    assert.equal(info.payment.onlineAvailable, false);
    assert.equal(info.payment.bank.iban, 'DE02100100100006820101');
    assert.match(info.payment.bank.reference, /^T17\/2027 /);
    assert.equal(info.payment.contactEmail, 'orga@example.com');
    const auto = await fetch(`http://localhost:${port}/public/registrations/${token}/checkout-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'auto' }) });
    assert.equal(auto.status, 409);
    assert.match((await auto.json()).error, /orga@example\.com/);
    const notice = (t) => fetch(`http://localhost:${port}/public/registrations/${t}/transfer-notice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await notice('not-a-token')).status, 404);
    assert.equal((await notice(token)).status, 200);
    assert.ok((await query('SELECT transfer_notified_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0].transfer_notified_at);
  });
  await query('UPDATE payment_settings SET contact_email = NULL');
});

test('reported transfers: staff can reset them, others cannot; overdue ones (3+ days, unpaid) are listed for the member menu only', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 3000);
  await query("UPDATE registrations SET transfer_notified_at = now() - interval '4 days' WHERE event_id = $1 AND user_id = $2", [eventId, userId]);
  const { rows: adminRows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Pay', 'Admin', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
    [`payments-repo-${crypto.randomUUID()}@example.com`]
  );
  const adminCookie = await makeSession(adminRows[0].id);
  const staff = await makeCheckinGroupUserAndSession();

  await withTestServer(async (port) => {
    const url = `http://localhost:${port}/events/${eventId}/registrations/${userId}/transfer-notice`;
    const overdue = (cookie) => fetch(`http://localhost:${port}/payments/overdue-transfers`, { headers: { Cookie: cookie } });

    assert.equal((await overdue(await makeSession(userId))).status, 403);
    assert.equal((await overdue(staff.cookie)).status, 403); // check-in staff has no member menu
    const list = await (await overdue(adminCookie)).json();
    assert.ok(list.some((t) => t.userId === userId));

    assert.equal((await fetch(url, { method: 'DELETE', headers: { Cookie: await makeSession(userId) } })).status, 403);
    assert.equal((await fetch(url, { method: 'DELETE', headers: { Cookie: staff.cookie } })).status, 200);
    assert.equal((await fetch(url, { method: 'DELETE', headers: { Cookie: adminCookie } })).status, 404); // already cleared
    assert.ok(!(await (await overdue(adminCookie)).json()).some((t) => t.userId === userId));
    // the person may report again
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await makeSession(userId) }, body: '{}' })).status, 200);
  });
});

test('SumUp webhook: wrong secret is 404; only a PAID, covering, matching checkout books the payment', async () => {
  const { setPaymentSettings, getPaymentSettingsForUse } = await import('../../backend/paymentSettings/repository.js');
  await setPaymentSettings({ sumupApiKey: 'sumup_test_key', sumupMerchantCode: 'MTEST', sumupEnabled: true });
  const { sumupWebhookSecret } = await getPaymentSettingsForUse();
  const eventId = await makeEvent();
  const userId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 4500);

  const realFetch = globalThis.fetch;
  let checkout;
  globalThis.fetch = (url, init) => String(url).startsWith('https://api.sumup.com/')
    ? Promise.resolve(new Response(JSON.stringify(checkout), { status: 200 }))
    : realFetch(url, init);
  try {
    await withTestServer(async (port) => {
      const hit = (secret) => realFetch(`http://localhost:${port}/webhooks/sumup/${secret}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'co-1' }),
      });
      const paid = async () => (await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0].paid_at;
      const base = { id: 'co-1', status: 'PAID', merchant_code: 'MTEST', currency: 'EUR', amount: 45, checkout_reference: `${eventId}:${userId}:abcd1234` };

      assert.equal((await hit('wrong-secret')).status, 404);
      assert.equal(await paid(), null);

      for (const bad of [{ status: 'PENDING' }, { merchant_code: 'OTHER' }, { currency: 'USD' }, { amount: 10 }, { checkout_reference: 'not-a-reference' }]) {
        checkout = { ...base, ...bad };
        assert.equal((await hit(sumupWebhookSecret)).status, 200);
        assert.equal(await paid(), null, `must not book for ${JSON.stringify(bad)}`);
      }

      checkout = base;
      assert.equal((await hit(sumupWebhookSecret)).status, 200);
      assert.notEqual(await paid(), null);
      assert.equal((await hit(sumupWebhookSecret)).status, 200); // idempotent
      const { rows } = await query("SELECT method FROM payments WHERE event_id = $1 AND user_id = $2", [eventId, userId]);
      assert.deepEqual(rows.map((r) => r.method), ['sumup']);
    });
  } finally {
    globalThis.fetch = realFetch;
    await query('UPDATE payment_settings SET sumup_api_key_enc = NULL, sumup_merchant_code = NULL, sumup_webhook_secret_enc = NULL');
  }
});

test.after(async () => {
  // payment_settings is one global row shared by every test file: leave it clean for the next one.
  await query('DELETE FROM payment_settings');
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
