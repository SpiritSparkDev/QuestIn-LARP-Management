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
import {
  setAmountDue, setDiscount, markPaidManually, markUnpaid, recordSuccessfulStripePayment,
  getRegistrationByPaymentToken, refundPayment, listUnpaidRegistrationsForEvent, setGuestPaymentToken,
} from './repository.js';

const CHECKOUT_METHODS = { card: 'stripe_card', paypal: 'stripe_paypal' };

// Shared by the authenticated (session-owned) and guest (payment-token-owned)
// checkout routes below -- everything except how the caller was authorized
// and where Stripe redirects afterward is identical.
async function createCheckoutSession({ eventId, userId, method, amountDueCents, successUrl, cancelUrl }) {
  const stripe = await getStripeClient();
  if (!stripe) return null;
  const event = await getEvent(eventId);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: [method],
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: amountDueCents,
        product_data: { name: `Teilnahmegebühr – ${event?.name ?? 'Event'}` },
      },
      quantity: 1,
    }],
    client_reference_id: `${eventId}:${userId}`,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session;
}

router.post('/events/:eventId/registrations/:userId/checkout-session', requireAuth(async ({ req, params, user }) => {
  if (params.userId !== user.id) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const stripeMethod = CHECKOUT_METHODS[body.method];
  if (!stripeMethod) return { status: 400, body: { error: 'method must be one of: card, paypal' } };

  const { rows } = await query(
    'SELECT amount_due_cents, paid_at FROM registrations WHERE event_id = $1 AND user_id = $2',
    [params.eventId, params.userId]
  );
  if (rows.length === 0) return { status: 404, body: { error: 'registration not found' } };
  if (rows[0].amount_due_cents == null) return { status: 400, body: { error: 'Für diese Anmeldung ist kein Betrag hinterlegt.' } };
  if (rows[0].paid_at) return { status: 409, body: { error: 'Bereits bezahlt.' } };

  const session = await createCheckoutSession({
    eventId: params.eventId,
    userId: params.userId,
    method: body.method,
    amountDueCents: rows[0].amount_due_cents,
    successUrl: `${baseUrl()}/account.html?payment=success#anmelden`,
    cancelUrl: `${baseUrl()}/account.html?payment=cancelled#anmelden`,
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
  const stripeMethod = CHECKOUT_METHODS[body.method];
  if (!stripeMethod) return { status: 400, body: { error: 'method must be one of: card, paypal' } };

  const registration = await getRegistrationByPaymentToken(params.token);
  if (!registration) return { status: 404, body: { error: 'Ungültiger Link.' } };
  if (new Date(registration.paymentTokenExpiresAt) < new Date()) {
    return { status: 410, body: { error: 'Dieser Zahlungslink ist abgelaufen.' } };
  }
  if (registration.amountDueCents == null) return { status: 400, body: { error: 'Für diese Anmeldung ist kein Betrag hinterlegt.' } };
  if (registration.paidAt) return { status: 409, body: { error: 'Bereits bezahlt.' } };

  const session = await createCheckoutSession({
    eventId: registration.eventId,
    userId: registration.userId,
    method: body.method,
    amountDueCents: registration.amountDueCents,
    successUrl: `${baseUrl()}/guest-payment.html?token=${params.token}&payment=success`,
    cancelUrl: `${baseUrl()}/guest-payment.html?token=${params.token}&payment=cancelled`,
  });
  if (!session) return { status: 502, body: { error: 'Zahlungen sind aktuell nicht konfiguriert.' } };
  return { status: 200, body: { url: session.url } };
});

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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const [eventId, userId] = (session.client_reference_id || '').split(':');
    if (eventId && userId) {
      try {
        await recordSuccessfulStripePayment({
          eventId, userId,
          method: session.payment_method_types?.includes('paypal') ? 'stripe_paypal' : 'stripe_card',
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
  let sent = 0;
  for (const reg of unpaid) {
    let payUrl = `${baseUrl()}/account.html?payment=reminder#anmelden`;
    if (reg.isGuest) {
      let token = reg.paymentToken;
      if (!token || new Date(reg.paymentTokenExpiresAt) < new Date()) {
        ({ token } = await setGuestPaymentToken(params.eventId, reg.userId, GUEST_PAYMENT_TOKEN_TTL_MS));
      }
      payUrl = `${baseUrl()}/guest-payment.html?token=${token}`;
    }
    try {
      await sendPaymentReminderEmail(reg.email, { eventName: event.name, amountDueCents: reg.amountDueCents, payUrl }, { transporter, from });
      sent++;
    } catch (err) {
      logger.error('failed to send payment reminder', { error: err.message, eventId: params.eventId, userId: reg.userId });
    }
  }
  return { status: 200, body: { sent, total: unpaid.length } };
})));
