import { isOffline } from '../appMode.js';
import { getPaymentSettingsForUse } from '../paymentSettings/repository.js';

// PayPal Orders API v2 (independent of Stripe): create an order, send the payer to
// PayPal to approve it, then capture it when the payer comes back.
const ORDER_ID = /^[A-Za-z0-9-]{5,64}$/;

// null while PayPal is not fully configured (or on the offline Con instance).
export async function getPaypalConfig() {
  if (isOffline()) return null;
  const { paypalClientId, paypalSecret, paypalSandbox, paypalEnabled } = await getPaymentSettingsForUse();
  if (!paypalClientId || !paypalSecret) return null;
  // `enabled` is the admin's switch: it only decides whether NEW orders start (returns of running ones still book).
  return { enabled: paypalEnabled, clientId: paypalClientId, secret: paypalSecret, base: paypalSandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com' };
}

export function isPaypalOrderId(value) {
  return typeof value === 'string' && ORDER_ID.test(value);
}

async function accessToken(config) {
  const res = await fetch(`${config.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`PayPal auth ${res.status}`);
  return body.access_token;
}

async function call(config, path, { method = 'GET', body, requestId } = {}) {
  const res = await fetch(`${config.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken(config)}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`PayPal API ${res.status}`);
    err.status = res.status;
    err.issues = (data.details ?? []).map((d) => d.issue);
    throw err;
  }
  return data;
}

// Returns { orderId, approveUrl }.
export async function createPaypalOrder(config, { reference, amountCents, description, returnUrl, cancelUrl, requestId }) {
  const order = await call(config, '/v2/checkout/orders', {
    method: 'POST',
    requestId,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: reference,
        description: description.slice(0, 127),
        amount: { currency_code: 'EUR', value: (amountCents / 100).toFixed(2) },
      }],
      payment_source: {
        paypal: {
          experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' },
        },
      },
    },
  });
  const link = (order.links ?? []).find((l) => l.rel === 'payer-action') ?? (order.links ?? []).find((l) => l.rel === 'approve');
  if (!order.id || !link?.href) throw new Error('PayPal order has no approval link');
  return { orderId: order.id, approveUrl: link.href };
}

export function getPaypalOrder(config, orderId) {
  if (!isPaypalOrderId(orderId)) throw new Error('invalid order id');
  return call(config, `/v2/checkout/orders/${orderId}`);
}

// Capturing twice is safe: PayPal answers ORDER_ALREADY_CAPTURED, then we just read the order.
export async function capturePaypalOrder(config, orderId) {
  if (!isPaypalOrderId(orderId)) throw new Error('invalid order id');
  try {
    return await call(config, `/v2/checkout/orders/${orderId}/capture`, { method: 'POST', requestId: `capture-${orderId}`, body: {} });
  } catch (err) {
    if (err.status === 422 && err.issues?.includes('ORDER_ALREADY_CAPTURED')) return getPaypalOrder(config, orderId);
    throw err;
  }
}

// What a finished order is worth: only a COMPLETED capture counts.
export function completedCapture(order) {
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (order?.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') return null;
  if (capture.amount?.currency_code !== 'EUR') return null;
  return {
    id: capture.id,
    amountCents: Math.round(Number(capture.amount.value) * 100),
    customId: order.purchase_units[0].custom_id ?? capture.custom_id ?? '',
  };
}
