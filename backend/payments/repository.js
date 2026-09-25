import { query, withTransaction } from '../db.js';

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

// Called from the Stripe webhook, which Stripe retries on any non-2xx or
// timeout -- ON CONFLICT DO NOTHING on provider_reference plus
// COALESCE(paid_at, now()) makes replays of the exact same event a no-op
// instead of a duplicate payments row or a paid_at that jumps forward.
export async function recordSuccessfulStripePayment({ eventId, userId, method, amountCents, providerReference }) {
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
      `INSERT INTO payments (user_id, event_id, method, amount_cents, provider_reference)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_reference) WHERE provider_reference IS NOT NULL DO NOTHING`,
      [userId, eventId, method, amountCents, providerReference]
    );
    if (rowCount === 0) return; // already recorded by an earlier delivery of the same webhook event
    await client.query(
      'UPDATE registrations SET paid_at = COALESCE(paid_at, now()) WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
  });
}
