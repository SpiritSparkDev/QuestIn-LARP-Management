import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu, requireAnyMenu } from '../middleware/authorize.js';
import { readJsonBody, readRawBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { displayName } from '../displayName.js';
import { getEvent } from '../events/repository.js';
import { baseUrl, getTransporterAndFrom, sendPaymentReminderEmail } from '../auth/mailer.js';
import crypto from 'node:crypto';
import { getStripeClient } from './stripeClient.js';
import { getSumupConfig, createSumupCheckout, getSumupCheckout } from './sumupClient.js';
import { getPaypalConfig, createPaypalOrder, capturePaypalOrder, completedCapture, isPaypalOrderId } from './paypalClient.js';
import { getPaymentSettingsForUse, getBankInfo } from '../paymentSettings/repository.js';
import { buildPaymentReference } from './reference.js';
import { canRegisterFor } from '../managedPersons/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { topUpFromStripe, findActiveAccountForUser } from '../tavern/repository.js';
import {
  setAmountDue, setDiscount, markPaidManually, markTransferNotified, clearTransferNotified, listOverdueTransfers, markUnpaid, recordSuccessfulStripePayment,
  getRegistrationByPaymentToken, refundPayment, listUnpaidRegistrationsForEvent, setGuestPaymentToken,
} from './repository.js';

const CHECKOUT_METHODS = ['card', 'paypal', 'bank_transfer', 'klarna', 'sepa_debit', 'sumup', 'paypal_direct'];
const CHECKOUT_METHOD_ERROR = `method must be one of: ${CHECKOUT_METHODS.join(', ')}`;
// The only methods whose ledger entry the tavern top-up knows (see TAVERN_LEDGER_METHODS).
const TAVERN_STRIPE_METHODS = ['card', 'paypal', 'bank_transfer'];

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
  if (types.includes('klarna')) return 'stripe_klarna';
  if (types.includes('sepa_debit')) return 'stripe_sepa_debit';
  return 'stripe_card';
}

// Shared by the authenticated (session-owned) and guest (payment-token-owned)
// checkout routes below -- everything except how the caller was authorized
// and where Stripe redirects afterward is identical.
async function createCheckoutSession({
  eventId, userId, method, amountDueCents, successUrl, cancelUrl,
  clientReferenceId = `${eventId}:${userId}`, productLabel = 'Teilnahmegebühr',
}) {
  if (method === 'sumup') return createSumupSession({ eventId, userId, amountDueCents, successUrl, productLabel });
  if (method === 'paypal_direct') return createPaypalSession({ eventId, userId, amountDueCents, successUrl, cancelUrl, productLabel });
  // Only the Stripe methods the admin switched on can be started.
  const stripeSettings = await getPaymentSettingsForUse();
  if (!stripeSettings.stripeEnabled || !stripeSettings.stripeMethods.includes(method)) return null;
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
  if (body.method !== 'auto' && !CHECKOUT_METHODS.includes(body.method)) return { status: 400, body: { error: CHECKOUT_METHOD_ERROR } };

  const { rows } = await query(
    'SELECT amount_due_cents, paid_at, con_payer FROM registrations WHERE event_id = $1 AND user_id = $2',
    [params.eventId, params.userId]
  );
  if (rows.length === 0) return { status: 404, body: { error: 'registration not found' } };
  if (!(await getEvent(params.eventId))?.payments_open) return { status: 409, body: { error: 'Zahlungen sind für dieses Event noch nicht freigegeben.' } };
  if (rows[0].con_payer) return { status: 409, body: { error: 'Als Con-Zahler bezahlst du vor Ort beim Check-In.' } };
  if (rows[0].amount_due_cents == null) return { status: 400, body: { error: 'Für diese Anmeldung ist kein Betrag hinterlegt.' } };
  if (rows[0].paid_at) return { status: 409, body: { error: 'Bereits bezahlt.' } };

  const method = body.method === 'auto' ? await firstOnlineMethod() : body.method;
  if (!method) return { status: 409, body: { error: await noOnlinePaymentMessage() } };

  const resolvedBaseUrl = await baseUrl();
  const session = await createCheckoutSession({
    eventId: params.eventId,
    userId: params.userId,
    method,
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
  // Same rule as the ticket in the account: paid, free or Con-Zahler.
  const ticketAllowed = Boolean(event?.code) && (
    Boolean(registration.paidAt) || registration.conPayer || registration.amountDueCents === 0
  );
  let ticket = null;
  if (ticketAllowed) {
    const { rows } = await query(
      'SELECT u.first_name, u.last_name, u.nickname, g.key AS group_key FROM users u JOIN groups g ON g.id = u.group_id WHERE u.id = $1',
      [registration.userId]
    );
    const u = rows[0];
    ticket = {
      participant: displayName({ firstName: u.first_name, lastName: u.last_name, nickname: u.nickname }),
      role: 'Ticket',
      eventDate: event.event_date,
      scanCode: `${event.code}-${u.group_key}-${registration.userId}`,
      conPayer: registration.conPayer && !registration.paidAt,
    };
  }
  // Open amount: what the page needs to pay -- an online method if one is set up, always the bank data.
  const open = !registration.paidAt && registration.amountDueCents > 0 && !registration.conPayer && Boolean(event?.payments_open);
  let payment = null;
  if (open) {
    const bank = await getBankInfo();
    const { rows } = await query('SELECT first_name, last_name FROM users WHERE id = $1', [registration.userId]);
    payment = {
      onlineAvailable: (await firstOnlineMethod()) !== null,
      transferNotifiedAt: (await query('SELECT transfer_notified_at FROM registrations WHERE event_id = $1 AND user_id = $2', [registration.eventId, registration.userId])).rows[0]?.transfer_notified_at ?? null,
      contactEmail: bank.contactEmail,
      paypalMeUrl: bank.paypalMeUrl,
      bank: bank.bankIban ? {
        iban: bank.bankIban, bic: bank.bankBic, accountHolder: bank.bankAccountHolder, qrEnabled: bank.bankQrEnabled,
        reference: buildPaymentReference(registration.eventId, registration.userId, { code: event.code, firstName: rows[0]?.first_name, lastName: rows[0]?.last_name }),
      } : null,
    };
  }
  return {
    status: 200,
    body: {
      eventName: event?.name ?? 'Event',
      amountDueCents: registration.amountDueCents,
      paid: Boolean(registration.paidAt),
      ticket,
      payment,
    },
  };
});

// "Ich habe überwiesen" for a guest: the token proves who they are.
router.post('/public/registrations/:token/transfer-notice', async ({ params }) => {
  const registration = await getRegistrationByPaymentToken(params.token);
  if (!registration) return { status: 404, body: { error: 'Ungültiger Link.' } };
  if (new Date(registration.paymentTokenExpiresAt) < new Date()) {
    return { status: 410, body: { error: 'Dieser Zahlungslink ist abgelaufen.' } };
  }
  if (!(await getEvent(registration.eventId))?.payments_open) return { status: 409, body: { error: 'Zahlungen sind für dieses Event noch nicht freigegeben.' } };
  const notifiedAt = await markTransferNotified(registration.eventId, registration.userId, registration.userId);
  if (!notifiedAt) return { status: 409, body: { error: 'Für diese Anmeldung ist keine offene Zahlung hinterlegt.' } };
  return { status: 200, body: { transferNotifiedAt: notifiedAt } };
});

// "Please ask the Orga", with the address if one is set.
async function noOnlinePaymentMessage() {
  const { contactEmail } = await getBankInfo();
  return `Aktuell ist keine Online-Zahlung eingerichtet. Bitte melde dich bei der Orga${contactEmail ? ` (${contactEmail})` : ''}.`;
}

// The guest payment page has no method picker: it takes the first online method that is set up.
async function firstOnlineMethod() {
  const forUse = await getPaymentSettingsForUse();
  const stripeMethods = forUse.stripeEnabled && (await getStripeClient()) ? forUse.stripeMethods : [];
  const candidates = [
    ['card', stripeMethods.includes('card')],
    ['paypal_direct', Boolean((await getPaypalConfig())?.enabled)],
    ['sumup', Boolean((await getSumupConfig())?.enabled)],
    ['paypal', stripeMethods.includes('paypal')],
    ['klarna', stripeMethods.includes('klarna')],
    ['bank_transfer', stripeMethods.includes('bank_transfer')],
    ['sepa_debit', stripeMethods.includes('sepa_debit')],
  ];
  return candidates.find(([, available]) => available)?.[0] ?? null;
}

router.post('/public/registrations/:token/checkout-session', async ({ req, params }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  if (body.method !== 'auto' && !CHECKOUT_METHODS.includes(body.method)) return { status: 400, body: { error: CHECKOUT_METHOD_ERROR } };

  const registration = await getRegistrationByPaymentToken(params.token);
  if (!registration) return { status: 404, body: { error: 'Ungültiger Link.' } };
  if (new Date(registration.paymentTokenExpiresAt) < new Date()) {
    return { status: 410, body: { error: 'Dieser Zahlungslink ist abgelaufen.' } };
  }
  if (!(await getEvent(registration.eventId))?.payments_open) return { status: 409, body: { error: 'Zahlungen sind für dieses Event noch nicht freigegeben.' } };
  if (registration.conPayer) return { status: 409, body: { error: 'Als Con-Zahler bezahlst du vor Ort beim Check-In.' } };
  if (registration.amountDueCents == null) return { status: 400, body: { error: 'Für diese Anmeldung ist kein Betrag hinterlegt.' } };
  if (registration.paidAt) return { status: 409, body: { error: 'Bereits bezahlt.' } };

  const method = body.method === 'auto' ? await firstOnlineMethod() : body.method;
  if (!method) return { status: 409, body: { error: await noOnlinePaymentMessage() } };

  const resolvedBaseUrl = await baseUrl();
  const session = await createCheckoutSession({
    eventId: registration.eventId,
    userId: registration.userId,
    method,
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
  // SumUp and direct PayPal book registration fees only; the tavern ledger knows just these Stripe methods.
  if (!TAVERN_STRIPE_METHODS.includes(body.method)) return { status: 400, body: { error: 'Das Tavernenkonto lässt sich nur per Karte, PayPal oder Banküberweisung (Stripe) aufladen.' } };
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

router.post('/events/:eventId/registrations/:userId/transfer-notice', requireAuth(async ({ params, user }) => {
  if (params.userId !== user.id && !(await canRegisterFor(params.userId, user.id))) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  if (!(await getEvent(params.eventId))?.payments_open) return { status: 409, body: { error: 'Zahlungen sind für dieses Event noch nicht freigegeben.' } };
  const notifiedAt = await markTransferNotified(params.eventId, params.userId, user.id);
  if (!notifiedAt) return { status: 409, body: { error: 'Für diese Anmeldung ist keine offene Zahlung hinterlegt.' } };
  return { status: 200, body: { transferNotifiedAt: notifiedAt } };
}));

// PayPal (direct, without Stripe). The payer approves on PayPal and comes back to
// /paypal/return, where the order is captured and booked. Everything that matters
// (amount, who, which event) comes from our own paypal_orders row and PayPal's answer,
// never from the browser: the only input is the order id, which PayPal made up.
async function createPaypalSession({ eventId, userId, amountDueCents, successUrl, cancelUrl, productLabel }) {
  const config = await getPaypalConfig();
  if (!config?.enabled) return null;
  const event = await getEvent(eventId);
  const base = await baseUrl();
  const { orderId, approveUrl } = await createPaypalOrder(config, {
    reference: `${eventId}:${userId}`,
    amountCents: amountDueCents,
    description: `${productLabel} – ${event?.name ?? 'Event'}`,
    returnUrl: `${base}/paypal/return`,
    cancelUrl: `${base}/paypal/cancel`,
    requestId: crypto.randomUUID(),
  });
  await query(
    'INSERT INTO paypal_orders (order_id, event_id, user_id, amount_cents, success_url, cancel_url) VALUES ($1, $2, $3, $4, $5, $6)',
    [orderId, eventId, userId, amountDueCents, successUrl, cancelUrl]
  );
  return { url: approveUrl };
}

const redirectTo = (location) => ({ status: 302, headers: { Location: location }, body: {} });

async function findPaypalOrder(req) {
  const orderId = new URL(req.url, 'http://localhost').searchParams.get('token');
  if (!isPaypalOrderId(orderId)) return null;
  const { rows } = await query(
    'SELECT order_id, event_id, user_id, success_url, cancel_url, captured_at FROM paypal_orders WHERE order_id = $1',
    [orderId]
  );
  return rows[0] ?? null;
}

router.get('/paypal/return', async ({ req }) => {
  const order = await findPaypalOrder(req);
  if (!order) return redirectTo(`${await baseUrl()}/account.html#anmelden`);
  if (order.captured_at) return redirectTo(order.success_url);
  try {
    const config = await getPaypalConfig();
    if (!config) return redirectTo(order.cancel_url);
    const capture = completedCapture(await capturePaypalOrder(config, order.order_id));
    const { rows } = await query('SELECT amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [order.event_id, order.user_id]);
    const due = rows[0]?.amount_due_cents;
    // Only a completed capture for this very registration that covers the open amount counts.
    if (!capture || capture.customId !== `${order.event_id}:${order.user_id}` || due == null || capture.amountCents < due) {
      logger.error('paypal payment not booked (not completed, wrong reference or amount below due)', { orderId: order.order_id, due, captured: capture?.amountCents });
      return redirectTo(order.cancel_url);
    }
    await recordSuccessfulStripePayment({
      eventId: order.event_id, userId: order.user_id, method: 'paypal', provider: 'paypal',
      amountCents: capture.amountCents, providerReference: `paypal:${capture.id}`,
    });
    await query('UPDATE paypal_orders SET captured_at = now() WHERE order_id = $1', [order.order_id]);
    return redirectTo(order.success_url);
  } catch (err) {
    logger.error('paypal return failed', { error: err.message, orderId: order.order_id });
    return redirectTo(order.cancel_url);
  }
});

router.get('/paypal/cancel', async ({ req }) => {
  const order = await findPaypalOrder(req);
  return redirectTo(order?.cancel_url ?? `${await baseUrl()}/account.html#anmelden`);
});

// Staff with the member list or the check-in: undo "Ich habe überwiesen" when no money arrived.
router.delete('/events/:eventId/registrations/:userId/transfer-notice', requireAuth(requireAnyMenu('mitglieder', 'checkin')(async ({ params, user }) => {
  if (!(await clearTransferNotified(params.eventId, params.userId, user.id))) return { status: 404, body: { error: 'Keine gemeldete Überweisung.' } };
  return { status: 200, body: { cleared: true } };
})));

// Dashboard reminder: reported transfers that are still unbooked after three days.
router.get('/payments/overdue-transfers', requireAuth(requireMenu('mitglieder')(async () => {
  return { status: 200, body: await listOverdueTransfers(3) };
})));

// SumUp hosted checkout. The returned object only needs `.url`, like a Stripe session.
async function createSumupSession({ eventId, userId, amountDueCents, successUrl, productLabel }) {
  const config = await getSumupConfig();
  if (!config?.enabled) return null;
  const event = await getEvent(eventId);
  // Unique per attempt; the webhook reads eventId/userId back from it.
  const reference = `${eventId}:${userId}:${crypto.randomBytes(4).toString('hex')}`;
  const checkout = await createSumupCheckout(config, {
    reference,
    amountCents: amountDueCents,
    description: `${productLabel} – ${event?.name ?? 'Event'}`,
    returnUrl: `${await baseUrl()}/webhooks/sumup/${config.webhookSecret}`,
    redirectUrl: successUrl,
  });
  return { url: checkout.hosted_checkout_url };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretsMatch(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Called by SumUp after a checkout changed. Two independent checks keep it safe:
// the secret in the URL, and -- more importantly -- the payment is only booked
// after re-reading the checkout from SumUp's API with our own key, so a forged
// call can at most make us look something up.
router.post('/webhooks/sumup/:secret', async ({ req, params }) => {
  const config = await getSumupConfig();
  // Same answer for "not configured" and "wrong secret": nothing to probe.
  if (!config || !secretsMatch(params.secret, config.webhookSecret)) return { status: 404, body: { error: 'not found' } };
  const body = await readJsonBody(req);
  const checkoutId = body?.id;
  let checkout;
  try {
    checkout = await getSumupCheckout(config, checkoutId);
  } catch (err) {
    logger.error('sumup webhook: could not read checkout', { error: err.message });
    return { status: 502, body: { error: 'checkout lookup failed' } };
  }
  if (checkout.status !== 'PAID' || checkout.merchant_code !== config.merchantCode || checkout.currency !== 'EUR') {
    return { status: 200, body: { received: true } };
  }
  const [eventId, userId] = String(checkout.checkout_reference ?? '').split(':');
  if (!UUID.test(eventId ?? '') || !UUID.test(userId ?? '')) return { status: 200, body: { received: true } };
  const paidCents = Math.round(Number(checkout.amount) * 100);
  try {
    const { rows } = await query('SELECT amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    // Only a payment that covers the open amount ends the open balance.
    if (rows.length === 0 || rows[0].amount_due_cents == null || paidCents < rows[0].amount_due_cents) {
      logger.error('sumup payment not booked (amount below due or no registration)', { checkoutId, eventId, userId, paidCents });
      return { status: 200, body: { received: true } };
    }
    await recordSuccessfulStripePayment({
      eventId, userId, method: 'sumup', provider: 'sumup',
      amountCents: paidCents, providerReference: `sumup:${checkout.id}`,
    });
  } catch (err) {
    logger.error('failed to record sumup payment', { error: err.message, eventId, userId, checkoutId });
  }
  return { status: 200, body: { received: true } };
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
        // The session was priced when it was created; the amount due may have grown since (extras booked later).
        const { rows: dueRows } = await query('SELECT amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
        const due = dueRows[0]?.amount_due_cents;
        if (due == null || session.currency !== 'eur' || session.amount_total < due) {
          logger.error('stripe payment not booked (amount below due, wrong currency or no registration)', { eventId, userId, sessionId: session.id, paid: session.amount_total, due });
          return { status: 200, body: { received: true } };
        }
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
  if (['stripe_card', 'stripe_paypal', 'stripe_klarna', 'stripe_sepa_debit'].includes(payment.method)) {
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
