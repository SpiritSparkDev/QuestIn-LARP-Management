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
const {
  setAmountDue, markPaidManually, markUnpaid, recordSuccessfulStripePayment,
} = await import('../../backend/payments/repository.js');

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

test.after(async () => {
  // payments.confirmed_by has no ON DELETE action, and a single multi-row
  // DELETE FROM users doesn't guarantee the registrations->payments cascade
  // for one test's participant runs before the confirmed_by check for
  // another test's admin in the same statement -- delete the referencing
  // payments rows explicitly first so the users delete never races it.
  await query("DELETE FROM payments WHERE confirmed_by IN (SELECT id FROM users WHERE email LIKE 'payments-repo-%')");
  await query("DELETE FROM users WHERE email LIKE 'payments-repo-%'");
  await query("DELETE FROM events WHERE name = 'Payments Repo Test Con'");
  await closePool();
});
