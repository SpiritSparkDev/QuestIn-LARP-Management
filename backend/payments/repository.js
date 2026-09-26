import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { displayName } from '../displayName.js';

function mapRegistrationRow(r) {
  return { userId: r.user_id, eventId: r.event_id, amountDueCents: r.amount_due_cents, paidAt: r.paid_at };
}

async function getRegistrationOrThrow(client, eventId, userId) {
  const { rows } = await client.query(
    'SELECT user_id, event_id, amount_due_cents, paid_at FROM registrations WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
    [eventId, userId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}

export async function setAmountDue(eventId, userId, amountDueCents) {
  const { rows } = await query(
    `UPDATE registrations SET amount_due_cents = $3 WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, amount_due_cents, paid_at`,
    [eventId, userId, amountDueCents]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return mapRegistrationRow(rows[0]);
}

// Sets a per-participant discount and, when this registration has a
// computed list price (price_list_cents, from an event's pricing config),
// recomputes amount_due_cents from it right away -- so an admin granting a
// discount sees the effective amount update immediately without a second
// step. A registration with no list price (event has no pricing configured,
// or the pricing table was exhausted at registration time) leaves
// amount_due_cents untouched: it's whatever the admin already entered
// manually via setAmountDue, and a discount on top of a manual entry isn't
// this function's job.
export async function setDiscount(eventId, userId, discountCents) {
  const { rows } = await query(
    `UPDATE registrations SET
       discount_cents = $3,
       amount_due_cents = CASE WHEN price_list_cents IS NOT NULL THEN GREATEST(price_list_cents - $3, 0) ELSE amount_due_cents END
     WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, amount_due_cents, paid_at, discount_cents`,
    [eventId, userId, discountCents]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return { ...mapRegistrationRow(rows[0]), discountCents: rows[0].discount_cents };
}

export async function markPaidManually(eventId, userId, confirmedByUserId) {
  return withTransaction(async (client) => {
    const registration = await getRegistrationOrThrow(client, eventId, userId);
    if (registration.amount_due_cents == null) {
      const err = new Error('Kein Betrag hinterlegt.');
      err.code = 'NO_AMOUNT_DUE';
      throw err;
    }
    // A double-click on "Als bezahlt markieren", a retried PATCH, or two
    // admin tabs acting on the same registration must not add a second
    // audit-trail row -- same idempotency concern as the Stripe webhook
    // path below, just gated on paid_at instead of provider_reference
    // since manual entries have no unique external reference to conflict on.
    if (registration.paid_at == null) {
      await client.query(
        `INSERT INTO payments (user_id, event_id, method, amount_cents, confirmed_by)
         VALUES ($1, $2, 'bank_transfer', $3, $4)`,
        [userId, eventId, registration.amount_due_cents, confirmedByUserId]
      );
    }
    const { rows } = await client.query(
      `UPDATE registrations SET paid_at = COALESCE(paid_at, now()) WHERE event_id = $1 AND user_id = $2
       RETURNING user_id, event_id, amount_due_cents, paid_at`,
      [eventId, userId]
    );
    return mapRegistrationRow(rows[0]);
  });
}

export async function markUnpaid(eventId, userId) {
  const { rows } = await query(
    `UPDATE registrations SET paid_at = NULL WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, amount_due_cents, paid_at`,
    [eventId, userId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return mapRegistrationRow(rows[0]);
}

// Lets a guest (no session, no password) reach Stripe checkout via an
// emailed link instead of the authenticated checkout-session route.
// Re-callable (not single-use): still valid for repeated checkout attempts
// until paid_at is set or it expires, covering abandoned/failed Stripe
// sessions -- mirrors how invitations.expires_at/redeemed_at gate reuse.
export async function setGuestPaymentToken(eventId, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs);
  await query(
    'UPDATE registrations SET payment_token = $3, payment_token_expires_at = $4 WHERE event_id = $1 AND user_id = $2',
    [eventId, userId, token, expiresAt]
  );
  return { token, expiresAt };
}

export async function getRegistrationByPaymentToken(token) {
  const { rows } = await query(
    `SELECT event_id, user_id, amount_due_cents, paid_at, payment_token_expires_at
     FROM registrations WHERE payment_token = $1`,
    [token]
  );
  if (rows.length === 0) return null;
  return {
    eventId: rows[0].event_id,
    userId: rows[0].user_id,
    amountDueCents: rows[0].amount_due_cents,
    paidAt: rows[0].paid_at,
    paymentTokenExpiresAt: rows[0].payment_token_expires_at,
  };
}

// Called from the Stripe webhook, which Stripe retries on any non-2xx or
// timeout -- ON CONFLICT DO NOTHING on provider_reference plus
// COALESCE(paid_at, now()) makes replays of the exact same event a no-op
// instead of a duplicate payments row or a paid_at that jumps forward.
export async function recordSuccessfulStripePayment({ eventId, userId, method, amountCents, providerReference, stripePaymentIntentId }) {
  await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT 1 FROM registrations WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
    if (existing.length === 0) {
      const err = new Error('registration not found');
      err.code = 'REGISTRATION_NOT_FOUND';
      throw err;
    }
    const { rowCount } = await client.query(
      `INSERT INTO payments (user_id, event_id, method, amount_cents, provider_reference, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider_reference) WHERE provider_reference IS NOT NULL DO NOTHING`,
      [userId, eventId, method, amountCents, providerReference, stripePaymentIntentId ?? null]
    );
    if (rowCount === 0) return; // already recorded by an earlier delivery of the same webhook event
    await client.query(
      'UPDATE registrations SET paid_at = COALESCE(paid_at, now()) WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
  });
}

// Everyone with an open balance for an event -- feeds the admin-triggered
// "send payment reminders" action (backend/payments/routes.js). Includes
// enough of the guest-payment-token state that the caller can lazily
// generate one for a guest who doesn't have one yet (e.g. the event only
// got priced after they registered).
export async function listUnpaidRegistrationsForEvent(eventId) {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.email, u.first_name, u.last_name, u.nickname, u.is_guest,
            r.amount_due_cents, r.payment_token, r.payment_token_expires_at
     FROM registrations r JOIN users u ON u.id = r.user_id
     WHERE r.event_id = $1 AND r.amount_due_cents > 0 AND r.paid_at IS NULL`,
    [eventId]
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
    isGuest: r.is_guest,
    amountDueCents: r.amount_due_cents,
    paymentToken: r.payment_token,
    paymentTokenExpiresAt: r.payment_token_expires_at,
  }));
}

// Refunds the current (not yet refunded) payment for a registration.
// `stripeRefundId` is set by the caller after a successful Stripe API
// refund; omitted entirely for a bank_transfer payment, which is refunded
// outside this system and only booked here. Only one refund action is
// supported per payments row -- a second call on an already-refunded
// payment is rejected rather than accumulating further partial refunds.
export async function refundPayment(eventId, userId, refundAmountCents, { stripeRefundId } = {}) {
  const { rows } = await query(
    `UPDATE payments SET refunded_at = now(), refund_amount_cents = $3, stripe_refund_id = $4
     WHERE id = (
       SELECT id FROM payments WHERE event_id = $1 AND user_id = $2 AND refunded_at IS NULL
       ORDER BY created_at DESC LIMIT 1
     )
     RETURNING id, user_id, event_id, method, amount_cents, refund_amount_cents, refunded_at`,
    [eventId, userId, refundAmountCents, stripeRefundId ?? null]
  );
  if (rows.length === 0) {
    const err = new Error('Keine (nicht bereits erstattete) Zahlung gefunden.');
    err.code = 'ALREADY_REFUNDED';
    throw err;
  }
  const r = rows[0];
  return {
    paymentId: r.id,
    userId: r.user_id,
    eventId: r.event_id,
    method: r.method,
    amountCents: r.amount_cents,
    refundAmountCents: r.refund_amount_cents,
    refundedAt: r.refunded_at,
  };
}
