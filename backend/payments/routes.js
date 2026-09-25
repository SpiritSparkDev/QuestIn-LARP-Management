import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody, readRawBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { baseUrl } from '../auth/mailer.js';
import { getStripeClient } from './stripeClient.js';
import { getPaymentSettingsForUse } from '../paymentSettings/repository.js';
import {
  setAmountDue, setDiscount, markPaidManually, markUnpaid, recordSuccessfulStripePayment,
} from './repository.js';

const CHECKOUT_METHODS = { card: 'stripe_card', paypal: 'stripe_paypal' };

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

  const stripe = await getStripeClient();
  if (!stripe) return { status: 502, body: { error: 'Zahlungen sind aktuell nicht konfiguriert.' } };

  const event = await getEvent(params.eventId);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: [body.method],
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: rows[0].amount_due_cents,
        product_data: { name: `Teilnahmegebühr – ${event?.name ?? 'Event'}` },
      },
      quantity: 1,
    }],
    client_reference_id: `${params.eventId}:${params.userId}`,
    success_url: `${baseUrl()}/account.html?payment=success#anmelden`,
    cancel_url: `${baseUrl()}/account.html?payment=cancelled#anmelden`,
  });
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
