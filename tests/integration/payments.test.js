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
      data: { object: { id: 'cs_test_webhook_1', client_reference_id: `${eventId}:${userId}`, amount_total: 2500, payment_method_types: ['card'] } },
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

test.after(async () => {
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
