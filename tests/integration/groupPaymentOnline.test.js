import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Stripe from 'stripe';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { withTestServer } = await import('../testServer.js');
const { setPaymentSettings, getPaymentSettingsForUse } = await import('../../backend/paymentSettings/repository.js');
const { createGroupPayment } = await import('../../backend/payments/repository.js');

const tag = crypto.randomUUID().slice(0, 8);
const WEBHOOK_SECRET = 'whsec_group_test';
const ORDER = `GRP${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

async function makeUser(firstName, { managedBy = null } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, email_verified, managed_by_user_id)
     VALUES ($1, $2, 'Gruppe', (SELECT id FROM groups WHERE key = 'mitglied'), true, $3) RETURNING id`,
    [`group-online-${tag}-${crypto.randomUUID()}@example.com`, firstName, managedBy]
  );
  return rows[0].id;
}

async function setup({ paymentsOpen = true } = {}) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active, payments_open, code) VALUES ('Group Online Con', '2027-08-01', true, $1, 'GO1/2027') RETURNING id",
    [paymentsOpen]
  );
  const eventId = rows[0].id;
  const payer = await makeUser('Boss');
  const a = await makeUser('Lena', { managedBy: payer });
  const b = await makeUser('Tom', { managedBy: payer });
  const stranger = await makeUser('Fremd');
  for (const [id, cents] of [[a, 3000], [b, 2000], [stranger, 1000]]) {
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role, status, amount_due_cents) VALUES ($1, $2, 'helfer', 'confirmed', $3)",
      [id, eventId, cents]
    );
  }
  return { eventId, payer, a, b, stranger, cookie: `session=${(await createSession(payer)).token}` };
}

const paidAt = async (eventId, userId) => (await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0].paid_at;

async function stripeWebhook(port, type, object) {
  const payload = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, data: { object } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return fetch(`http://localhost:${port}/webhooks/stripe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload,
  });
}

const post = (port, path, cookie, body) => fetch(`http://localhost:${port}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
});

test('Stripe webhook G:<id> books every person once, a replay books nothing twice', async () => {
  await setPaymentSettings({ stripeSecretKey: 'sk_test_dummy', stripeWebhookSecret: WEBHOOK_SECRET, stripeEnabled: true });
  const s = await setup();
  const gid = await createGroupPayment(s.eventId, s.payer, [s.a, s.b]);
  const session = {
    id: `cs_group_${crypto.randomUUID()}`, client_reference_id: `G:${gid}`, amount_total: 5000, currency: 'eur',
    payment_method_types: ['card'], payment_status: 'paid', payment_intent: 'pi_group_1',
  };
  await withTestServer(async (port) => {
    assert.equal((await stripeWebhook(port, 'checkout.session.completed', session)).status, 200);
    assert.equal((await stripeWebhook(port, 'checkout.session.completed', session)).status, 200);
  });
  assert.ok(await paidAt(s.eventId, s.a));
  assert.ok(await paidAt(s.eventId, s.b));
  assert.equal(await paidAt(s.eventId, s.stranger), null);
  const { rows } = await query('SELECT user_id, amount_cents, method, stripe_payment_intent_id FROM payments WHERE event_id = $1 ORDER BY amount_cents', [s.eventId]);
  assert.deepEqual(rows.map((r) => [r.amount_cents, r.method, r.stripe_payment_intent_id]), [[2000, 'stripe_card', 'pi_group_1'], [3000, 'stripe_card', 'pi_group_1']]);
});

test('Stripe webhook G:<id> books nothing when the amount is below the sum due', async () => {
  const s = await setup();
  const gid = await createGroupPayment(s.eventId, s.payer, [s.a, s.b]);
  await withTestServer(async (port) => {
    const res = await stripeWebhook(port, 'checkout.session.completed', {
      id: `cs_group_${crypto.randomUUID()}`, client_reference_id: `G:${gid}`, amount_total: 4999, currency: 'eur',
      payment_method_types: ['card'], payment_status: 'paid',
    });
    assert.equal(res.status, 200);
  });
  assert.equal(await paidAt(s.eventId, s.a), null);
  assert.equal(await paidAt(s.eventId, s.b), null);
});

test('SumUp webhook with a G: reference books every person', async () => {
  await setPaymentSettings({ sumupApiKey: 'sumup_test_key', sumupMerchantCode: 'MTEST', sumupEnabled: true });
  const { sumupWebhookSecret } = await getPaymentSettingsForUse();
  const s = await setup();
  const gid = await createGroupPayment(s.eventId, s.payer, [s.a, s.b]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => String(url).startsWith('https://api.sumup.com/')
    ? Promise.resolve(new Response(JSON.stringify({ id: 'co-g1', status: 'PAID', merchant_code: 'MTEST', currency: 'EUR', amount: 50, checkout_reference: `G:${gid}:abcd1234` }), { status: 200 }))
    : realFetch(url, init);
  try {
    await withTestServer(async (port) => {
      const hit = () => realFetch(`http://localhost:${port}/webhooks/sumup/${sumupWebhookSecret}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'co-g1' }) });
      assert.equal((await hit()).status, 200);
      assert.equal((await hit()).status, 200);
    });
  } finally {
    globalThis.fetch = realFetch;
    await query('UPDATE payment_settings SET sumup_api_key_enc = NULL, sumup_merchant_code = NULL, sumup_webhook_secret_enc = NULL');
  }
  assert.ok(await paidAt(s.eventId, s.a));
  assert.ok(await paidAt(s.eventId, s.b));
  const { rows } = await query("SELECT method FROM payments WHERE event_id = $1", [s.eventId]);
  assert.deepEqual(rows.map((r) => r.method), ['sumup', 'sumup']);
});

test('PayPal buttons: group order is created and captured into one booking per person', async () => {
  await setPaymentSettings({ paypalClientId: 'cid', paypalSecret: 'secret', paypalEnabled: true, paypalButtonsEnabled: true });
  const s = await setup();
  const realFetch = globalThis.fetch;
  let customId;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.includes('paypal.com/v1/oauth2/token')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }));
    if (u.endsWith('/v2/checkout/orders')) {
      customId = JSON.parse(init.body).purchase_units[0].custom_id;
      return Promise.resolve(new Response(JSON.stringify({ id: ORDER }), { status: 201 }));
    }
    if (u.includes(`/v2/checkout/orders/${ORDER}/capture`)) {
      return Promise.resolve(new Response(JSON.stringify({
        status: 'COMPLETED',
        purchase_units: [{ custom_id: customId, payments: { captures: [{ id: 'CAPG1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '50.00' } }] } }],
      }), { status: 200 }));
    }
    return realFetch(url, init);
  };
  try {
    await withTestServer(async (port) => {
      const res = await post(port, `/events/${s.eventId}/group-payment/paypal-order`, s.cookie, { userIds: [s.a, s.b] });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).orderId, ORDER);
      assert.match(customId, /^G:[0-9a-f-]{36}$/);
      const capture = () => realFetch(`http://localhost:${port}/paypal/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: ORDER }) });
      assert.equal((await capture()).status, 200);
      assert.equal((await capture()).status, 200);
    });
  } finally {
    globalThis.fetch = realFetch;
    await query('UPDATE payment_settings SET paypal_client_id = NULL, paypal_secret_enc = NULL, paypal_enabled = false, paypal_buttons_enabled = false');
  }
  assert.ok(await paidAt(s.eventId, s.a));
  assert.ok(await paidAt(s.eventId, s.b));
  const { rows } = await query("SELECT method FROM payments WHERE event_id = $1", [s.eventId]);
  assert.deepEqual(rows.map((r) => r.method), ['paypal', 'paypal']);
});

test('summary returns total and persons; checkout-session validates like the other group routes', async () => {
  const s = await setup();
  await withTestServer(async (port) => {
    const summary = await post(port, `/events/${s.eventId}/group-payment/summary`, s.cookie, { userIds: [s.a, s.b] });
    assert.equal(summary.status, 200);
    const body = await summary.json();
    assert.equal(body.totalCents, 5000);
    assert.deepEqual(body.persons.map((p) => p.userId).sort(), [s.a, s.b].sort());

    const url = `/events/${s.eventId}/group-payment/checkout-session`;
    assert.equal((await post(port, url, s.cookie, { userIds: [s.a, s.stranger], method: 'card' })).status, 403);
    assert.equal((await post(port, url, s.cookie, { userIds: [s.a], method: 'bitcoin' })).status, 400);
    assert.equal((await post(port, url, s.cookie, { userIds: [] , method: 'card' })).status, 400);
    await query('UPDATE registrations SET paid_at = now() WHERE event_id = $1 AND user_id = $2', [s.eventId, s.b]);
    assert.equal((await post(port, url, s.cookie, { userIds: [s.a, s.b], method: 'card' })).status, 409);
    const closed = await setup({ paymentsOpen: false });
    assert.equal((await post(port, `/events/${closed.eventId}/group-payment/checkout-session`, closed.cookie, { userIds: [closed.a], method: 'card' })).status, 409);
  });
});

test('checkout-session with SumUp creates a group payment with a G: reference and the group text', async () => {
  await setPaymentSettings({ sumupApiKey: 'sumup_test_key', sumupMerchantCode: 'MTEST', sumupEnabled: true });
  const s = await setup();
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = (url, init) => {
    if (!String(url).startsWith('https://api.sumup.com/')) return realFetch(url, init);
    sent = JSON.parse(init.body);
    return Promise.resolve(new Response(JSON.stringify({ id: 'co-x', hosted_checkout_url: 'https://pay.sumup.example/x' }), { status: 200 }));
  };
  try {
    await withTestServer(async (port) => {
      const res = await post(port, `/events/${s.eventId}/group-payment/checkout-session`, s.cookie, { userIds: [s.a, s.b], method: 'sumup' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).url, 'https://pay.sumup.example/x');
    });
  } finally {
    globalThis.fetch = realFetch;
    await query('UPDATE payment_settings SET sumup_api_key_enc = NULL, sumup_merchant_code = NULL, sumup_webhook_secret_enc = NULL');
  }
  const { rows } = await query('SELECT id, payer_id, user_ids FROM group_payments WHERE event_id = $1', [s.eventId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payer_id, s.payer);
  assert.ok(sent.checkout_reference.startsWith(`G:${rows[0].id}:`));
  assert.equal(sent.amount, 50);
  assert.match(sent.description, /Boss-Gruppe: Lena, Tom/);
});

test.after(async () => {
  await query('DELETE FROM payment_settings');
  await query('DELETE FROM users WHERE email LIKE $1', [`group-online-${tag}-%`]);
  await query("DELETE FROM events WHERE name = 'Group Online Con'");
  await closePool();
});
