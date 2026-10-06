import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody, readRawBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { baseUrl, getTransporterAndFrom, sendPaymentReminderEmail } from '../auth/mailer.js';
import { getStripeClient } from './stripeClient.js';
import { getPaymentSettingsForUse } from '../paymentSettings/repository.js';
import { canRegisterFor } from '../managedPersons/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { topUpFromStripe, findActiveAccountForUser } from '../tavern/repository.js';
import {
  setAmountDue, setDiscount, markPaidManually, markUnpaid, recordSuccessfulStripePayment,
  getRegistrationByPaymentToken, refundPayment, listUnpaidRegistrationsForEvent, setGuestPaymentToken,
} from './repository.js';

const CHECKOUT_METHODS = ['card', 'paypal', 'bank_transfer'];
const CHECKOUT_METHOD_ERROR = 'method must be one of: card, paypal, bank_transfer';

// Stripe bank transfer (customer_balance) is a delayed-notification method
// that requires an existing Customer on the Checkout Session; a fresh
// Customer per session also gets a fresh virtual IBAN, so a transfer can
// only ever match this one payment.
async function bankTransferSessionParams(userId, eventId, stripe) {
  const { rows } = await query('SELECT email, first_name, last_name FROM users WHERE id = $1', [userId]);
  const customer = await stripe.customers.create({
    email: rows[0]?.email,
    name: [rows[0]?.first_name, rows[0]?.last_name].filter(Boolean).join(' ') || undefined,
    metadata: { eventId, userId },
  });
  return {
    customer: customer.id,
    payment_method_types: ['customer_balance'],
    payment_method_options: {
      customer_balance: {
        funding_type: 'bank_transfer',
        bank_transfer: { type: 'eu_bank_transfer', eu_bank_transfer: { country: 'DE' } },
      },
    },
  };
}

// 'checkout.session.completed' only means the customer submitted the form;
// for delayed methods the money arrives later (checkout.session.async_payment_succeeded).
function stripeMethodForSession(session) {
  const types = session.payment_method_types ?? [];
  if (types.includes('customer_balance')) return 'stripe_bank_transfer';
  if (types.includes('paypal')) return 'stripe_paypal';
  return 'stripe_card';
}

// Shared by the authenticated (session-owned) and guest (payment-token-owned)
// checkout routes below -- everything except how the caller was authorized
// and where Stripe redirects afterward is identical.
async function createCheckoutSession({
  eventId, userId, method, amountDueCents, successUrl, cancelUrl,
  clientReferenceId = `${eventId}:${userId}`, productLabel = 'Teilnahmegebühr',
}) {
  const stripe = await getStripeClient();
  if (!stripe) return null;
  const event = await getEvent(eventId);
  const methodParams = method === 'bank_transfer'
    ? await bankTransferSessionParams(userId, eventId, stripe)
    : { payment_method_types: [method] };
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ...methodParams,
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: amountDueCents,
        product_data: { name: `${productLabel} – ${event?.name ?? 'Event'}` },
      },
      quantity: 1,
    }],
    client_reference_id: clientReferenceId,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session;
}

router.post('/events/:eventId/registrations/:userId/checkout-session', requireAuth(async ({ req, params, user }) => {
  if (params.userId !== user.id && !(await canRegisterFor(params.userId, user.id))) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!CHECKOUT_METHODS.includes(body.method)) return { status: 400, body: { error: CHECKOUT_METHOD_ERROR } };

  const { rows } = await query(
    'SELECT amount_due_cents, paid_at FROM registrations WHERE event_id = $1 AND user_id = $2',
    [params.eventId, params.userId]
  );
  if (rows.length === 0) return { status: 404, body: { error: 'registration not found' } };
  if (rows[0].amount_due_cents == null) return { status: 400, body: { error: 'Für diese Anmeldung ist kein Betrag hinterlegt.' } };
  if (rows[0].paid_at) return { status: 409, body: { error: 'Bereits bezahlt.' } };

  const resolvedBaseUrl = await baseUrl();
  const session = await createCheckoutSession({
    eventId: params.eventId,
    userId: params.userId,
    method: body.method,
    amountDueCents: rows[0].amount_due_cents,
    successUrl: `${resolvedBaseUrl}/account.html?payment=success#anmelden`,
    cancelUrl: `${resolvedBaseUrl}/account.html?payment=cancelled#anmelden`,
  });
  if (!session) return { status: 502, body: { error: 'Zahlungen sind aktuell nicht konfiguriert.' } };
  return { status: 200, body: { url: session.url } };
}));

// Guest counterpart of the route above: a guest has no session (no
// password, can't log in), so ownership is proven by possessing the
// single-purpose token mailed to them at registration time
// (backend/guestRegistrations/routes.js) instead of by `requireAuth`. The
// authenticated route's own ownership check (`params.userId !== user.id`)
// is untouched -- this is a separate, thin sibling route, not a
// modification of it.
router.get('/public/registrations/:token', async ({ params }) => {
  const registration = await getRegistrationByPaymentToken(params.token);
  if (!registration) return { status: 404, body: { error: 'Ungültiger Link.' } };
  if (new Date(registration.paymentTokenExpiresAt) < new Date()) {
    return { status: 410, body: { error: 'Dieser Zahlungslink ist abgelaufen.' } };
  }
  const event = await getEvent(registration.eventId);
  return {
    status: 200,
    body: {
      eventName: event?.name ?? 'Event',
      amountDueCents: registration.amountDueCents,
      paid: Boolean(registration.paidAt),
    },
  };
});

router.post('/public/registrations/:token/checkout-session', async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!CHECKOUT_METHODS.includes(body.method)) return { status: 400, body: { error: CHECKOUT_METHOD_ERROR } };

  const registration = await getRegistrationByPaymentToken(params.token);
  if (!registration) return { status: 404, body: { error: 'Ungültiger Link.' } };
  if (new Date(registration.paymentTokenExpiresAt) < new Date()) {
    return { status: 410, body: { error: 'Dieser Zahlungslink ist abgelaufen.' } };
  }
  if (registration.amountDueCents == null) return { status: 400, body: { error: 'Für diese Anmeldung ist kein Betrag hinterlegt.' } };
  if (registration.paidAt) return { status: 409, body: { error: 'Bereits bezahlt.' } };

  const resolvedBaseUrl = await baseUrl();
  const session = await createCheckoutSession({
    eventId: registration.eventId,
    userId: registration.userId,
    method: body.method,
    amountDueCents: registration.amountDueCents,
    successUrl: `${resolvedBaseUrl}/guest-payment.html?token=${params.token}&payment=success`,
    cancelUrl: `${resolvedBaseUrl}/guest-payment.html?token=${params.token}&payment=cancelled`,
  });
  if (!session) return { status: 502, body: { error: 'Zahlungen sind aktuell nicht konfiguriert.' } };
  return { status: 200, body: { url: session.url } };
});

// Participant tops up their own Tavernenkonto online. The webhook below tells
// these sessions apart from event-fee payments by the "tavern:<accountId>"
// client_reference_id.
const TAVERN_REFERENCE_PREFIX = 'tavern:';
const TAVERN_LEDGER_METHODS = { stripe_card: 'card', stripe_paypal: 'paypal', stripe_bank_transfer: 'bank_transfer' };
const TAVERN_TOPUP_MIN_CENTS = 500;
const TAVERN_TOPUP_MAX_CENTS = 20000;

router.post('/tavern/my-topup-session', requireAuth(async ({ req, user }) => {
  const settings = await getAppSettings();
  if (!settings.tavernEnabled) return { status: 404, body: { error: 'Das Tavernenkonto ist nicht aktiviert.' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (!CHECKOUT_METHODS.includes(body.method)) return { status: 400, body: { error: CHECKOUT_METHOD_ERROR } };
  if (!Number.isInteger(body.amountCents) || body.amountCents < TAVERN_TOPUP_MIN_CENTS || body.amountCents > TAVERN_TOPUP_MAX_CENTS) {
    return { status: 400, body: { error: 'Der Betrag muss zwischen 5 und 200 Euro liegen.' } };
  }
  const account = await findActiveAccountForUser(user.id);
  if (!account) return { status: 404, body: { error: 'Du hast für das aktuelle Event noch kein Tavernenkonto.' } };
  if (account.locked) return { status: 409, body: { error: 'Dein Tavernenkonto ist gesperrt.' } };

  const resolvedBaseUrl = await baseUrl();
  const session = await createCheckoutSession({
    eventId: account.eventId,
    userId: user.id,
    method: body.method,
    amountDueCents: body.amountCents,
    clientReferenceId: `${TAVERN_REFERENCE_PREFIX}${account.id}`,
    productLabel: 'Tavernenkonto-Aufladung',
    successUrl: `${resolvedBaseUrl}/account.html?tavern=success#dashboard`,
    cancelUrl: `${resolvedBaseUrl}/account.html?tavern=cancelled#dashboard`,
  });
  if (!session) return { status: 502, body: { error: 'Zahlungen sind aktuell nicht konfiguriert.' } };
  return { status: 200, body: { url: session.url } };
}));

router.post('/webhooks/stripe', async ({ req }) => {
  const rawBody = await readRawBody(req);
  if (rawBody === null) return { status: 400, body: { error: 'invalid body' } };

  const { stripeWebhookSecret } = await getPaymentSettingsForUse();
  const stripe = await getStripeClient();
  if (!stripe || !stripeWebhookSecret) return { status: 503, body: { error: 'Stripe ist nicht konfiguriert.' } };

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], stripeWebhookSecret);
  } catch (err) {
    logger.error('stripe webhook signature verification failed', { error: err.message });
    return { status: 400, body: { error: 'invalid signature' } };
  }

  const session = event.data.object;
  const isPaidNow = event.type === 'checkout.session.completed' && session.payment_status === 'paid';
  if (isPaidNow || event.type === 'checkout.session.async_payment_succeeded') {
    const reference = session.client_reference_id || '';
    const [eventId, userId] = reference.split(':');
    if (reference.startsWith(TAVERN_REFERENCE_PREFIX)) {
      try {
        await topUpFromStripe(reference.slice(TAVERN_REFERENCE_PREFIX.length), {
          amountCents: session.amount_total,
          method: TAVERN_LEDGER_METHODS[stripeMethodForSession(session)],
          providerReference: session.id,
        });
      } catch (err) {
        logger.error('failed to book tavern top-up', { error: err.message, reference, sessionId: session.id });
      }
    } else if (eventId && userId) {
      try {
        await recordSuccessfulStripePayment({
          eventId, userId,
          method: stripeMethodForSession(session),
          amountCents: session.amount_total,
          providerReference: session.id,
          stripePaymentIntentId: session.payment_intent,
        });
      } catch (err) {
        // Always 200 back to Stripe even on our own failure to process
        // (e.g. the registration was deleted in the meantime) -- a non-2xx
        // here makes Stripe retry the same event indefinitely.
        logger.error('failed to record stripe payment', { error: err.message, eventId, userId, sessionId: session.id });
      }
    }
  }

  return { status: 200, body: { received: true } };
});

router.patch('/events/:eventId/registrations/:userId/payment', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    if (body.amountDueCents !== undefined) {
      if (body.amountDueCents !== null && (!Number.isInteger(body.amountDueCents) || body.amountDueCents < 0)) {
        return { status: 400, body: { error: 'amountDueCents must be a non-negative integer or null' } };
      }
      const registration = await setAmountDue(params.eventId, params.userId, body.amountDueCents);
      return { status: 200, body: registration };
    }
    if (body.discountCents !== undefined) {
      if (!Number.isInteger(body.discountCents) || body.discountCents < 0) {
        return { status: 400, body: { error: 'discountCents must be a non-negative integer' } };
      }
      const registration = await setDiscount(params.eventId, params.userId, body.discountCents);
      return { status: 200, body: registration };
    }
    if (body.markPaid === true) {
      const registration = await markPaidManually(params.eventId, params.userId, user.id);
      return { status: 200, body: registration };
    }
    if (body.markPaid === false) {
      const registration = await markUnpaid(params.eventId, params.userId);
      return { status: 200, body: registration };
    }
    return { status: 400, body: { error: 'expected amountDueCents, discountCents, or markPaid' } };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'NO_AMOUNT_DUE') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

// A bank-transfer payment is refunded outside this system (staff already
// sent the money back manually) -- this just books it. A Stripe payment
// actually calls Stripe first, and only books it once that succeeds. Full
// or partial: `amountCents` defaults to the payment's own full amount.
router.post('/events/:eventId/registrations/:userId/refund', requireAuth(requireMenu('checkin')(async ({ req, params }) => {
  const body = (await readJsonBody(req)) ?? {};
  if (body.amountCents !== undefined && (!Number.isInteger(body.amountCents) || body.amountCents <= 0)) {
    return { status: 400, body: { error: 'amountCents must be a positive integer' } };
  }

  const { rows } = await query(
    `SELECT amount_cents, method, stripe_payment_intent_id FROM payments
     WHERE event_id = $1 AND user_id = $2 AND refunded_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [params.eventId, params.userId]
  );
  if (rows.length === 0) return { status: 404, body: { error: 'Keine (nicht bereits erstattete) Zahlung gefunden.' } };
  const payment = rows[0];
  const amountCents = body.amountCents ?? payment.amount_cents;
  if (amountCents > payment.amount_cents) {
    return { status: 400, body: { error: 'amountCents darf den bezahlten Betrag nicht übersteigen.' } };
  }

  if (payment.method === 'stripe_bank_transfer') {
    return { status: 409, body: { error: 'Stripe-Banküberweisungen bitte im Stripe-Dashboard erstatten (Kundenguthaben/Banküberweisung), das lässt sich hier nicht automatisch abbilden.' } };
  }

  let stripeRefundId = null;
  if (payment.method === 'stripe_card' || payment.method === 'stripe_paypal') {
    if (!payment.stripe_payment_intent_id) {
      return {
        status: 409,
        body: { error: 'Diese Zahlung hat keine Stripe-Zahlungsreferenz (z.B. vor dieser Funktion erfasst) und kann hier nicht automatisch erstattet werden. Bitte im Stripe-Dashboard erstatten.' },
      };
    }
    const stripe = await getStripeClient();
    if (!stripe) return { status: 502, body: { error: 'Zahlungen sind aktuell nicht konfiguriert.' } };
    const refund = await stripe.refunds.create({ payment_intent: payment.stripe_payment_intent_id, amount: amountCents });
    stripeRefundId = refund.id;
  }

  try {
    const result = await refundPayment(params.eventId, params.userId, amountCents, { stripeRefundId });
    return { status: 200, body: result };
  } catch (err) {
    if (err.code === 'ALREADY_REFUNDED') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));

const GUEST_PAYMENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

router.post('/events/:eventId/payment-reminders', requireAuth(requireMenu('checkin')(async ({ params }) => {
  const event = await getEvent(params.eventId);
  if (!event) return { status: 404, body: { error: 'event not found' } };

  const unpaid = await listUnpaidRegistrationsForEvent(params.eventId);
  const { transporter, from } = await getTransporterAndFrom();
  const resolvedBaseUrl = await baseUrl();
  let sent = 0;
  for (const reg of unpaid) {
    let payUrl = `${resolvedBaseUrl}/account.html?payment=reminder#anmelden`;
    if (reg.isGuest) {
      let token = reg.paymentToken;
      if (!token || new Date(reg.paymentTokenExpiresAt) < new Date()) {
        ({ token } = await setGuestPaymentToken(params.eventId, reg.userId, GUEST_PAYMENT_TOKEN_TTL_MS));
      }
      payUrl = `${resolvedBaseUrl}/guest-payment.html?token=${token}`;
    }
    try {
      await sendPaymentReminderEmail(reg.email, { eventName: event.name, amountDueCents: reg.amountDueCents, payUrl, userId: reg.userId }, { transporter, from });
      sent++;
    } catch (err) {
      logger.error('failed to send payment reminder', { error: err.message, eventId: params.eventId, userId: reg.userId });
    }
  }
  return { status: 200, body: { sent, total: unpaid.length } };
})));
