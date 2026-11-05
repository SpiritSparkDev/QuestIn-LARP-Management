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
const { setPaymentSettings } = await import('../../backend/paymentSettings/repository.js');
const { createGroupPayment, recordGroupPayment } = await import('../../backend/payments/repository.js');

const tag = crypto.randomUUID().slice(0, 8);

async function makeUser(firstName) {
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, email_verified)
     VALUES ($1, $2, 'Gruppe', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id`,
    [`group-op-${tag}-${crypto.randomUUID()}@example.com`, firstName]
  );
  return rows[0].id;
}

async function setup() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active, payments_open, code) VALUES ('Group OP Con', '2027-09-01', true, true, 'GOP1/2027') RETURNING id"
  );
  const eventId = rows[0].id;
  const payer = await makeUser('Boss');
  const a = await makeUser('Lena');
  const b = await makeUser('Tom');
  for (const [id, cents] of [[a, 3000], [b, 2000]]) {
    await query(
      "INSERT INTO registrations (user_id, event_id, con_role, status, amount_due_cents) VALUES ($1, $2, 'helfer', 'confirmed', $3)",
      [id, eventId, cents]
    );
  }
  return { eventId, payer, a, b };
}

test('group payment skips an already paid person and logs payment.overpaid for them only', async () => {
  const s = await setup();
  const gid = await createGroupPayment(s.eventId, s.payer, [s.a, s.b]);
  await query('UPDATE registrations SET paid_at = now() WHERE event_id = $1 AND user_id = $2', [s.eventId, s.b]);
  const pay = () => recordGroupPayment({ groupPaymentId: gid, method: 'stripe_card', provider: 'stripe', paidCents: 5000, providerReference: 'cs_op_1' });

  assert.equal(await pay(), true);
  // replay: person a is now booked by this very payment and must not count as overpaid
  assert.equal(await pay(), true);

  const { rows: pays } = await query('SELECT user_id, amount_cents FROM payments WHERE event_id = $1', [s.eventId]);
  assert.deepEqual(pays.map((p) => [p.user_id, p.amount_cents]), [[s.a, 3000]]);
  const { rows: over } = await query("SELECT subject_user_id, details FROM audit_log WHERE action = 'payment.overpaid' AND details->>'groupPaymentId' = $1", [gid]);
  assert.equal(over.length, 1);
  assert.equal(over[0].subject_user_id, s.b);
  assert.equal(over[0].details.amountCents, 2000);
  assert.equal(over[0].details.reference, 'cs_op_1');
  assert.equal(over[0].details.eventId, s.eventId);
});

test('refund of one group-paid person refunds only their amount on the shared payment intent', async () => {
  await setPaymentSettings({ stripeSecretKey: 'sk_test_dummy', stripeEnabled: true });
  const s = await setup();
  const gid = await createGroupPayment(s.eventId, s.payer, [s.a, s.b]);
  await recordGroupPayment({ groupPaymentId: gid, method: 'stripe_card', provider: 'stripe', paidCents: 5000, providerReference: 'cs_op_2', stripePaymentIntentId: 'pi_op_2' });

  // The built-in admin group: tests must not leave extra groups behind (seedGroups.test.js expects exactly 3).
  const { rows: adm } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Ad', 'Min', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
    [`op-admin-${tag}@example.com`]
  );
  const cookie = `session=${(await createSession(adm[0].id)).token}`;

  const RefundResource = Object.getPrototypeOf(new Stripe('sk_test_dummy').refunds);
  const realCreate = RefundResource.create;
  const calls = [];
  RefundResource.create = async (params) => { calls.push(params); return { id: 're_op_1' }; };
  try {
    await withTestServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/events/${s.eventId}/registrations/${s.a}/refund`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
      });
      assert.equal(res.status, 200);
    });
  } finally {
    RefundResource.create = realCreate;
    await query('UPDATE payment_settings SET stripe_secret_key_enc = NULL, stripe_enabled = false');
  }
  assert.deepEqual(calls, [{ payment_intent: 'pi_op_2', amount: 3000 }]);
  const { rows } = await query('SELECT user_id, refunded_at, refund_amount_cents FROM payments WHERE event_id = $1', [s.eventId]);
  const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r]));
  assert.ok(byUser[s.a].refunded_at);
  assert.equal(byUser[s.a].refund_amount_cents, 3000);
  assert.equal(byUser[s.b].refunded_at, null);
});

test.after(async () => { await closePool(); });
