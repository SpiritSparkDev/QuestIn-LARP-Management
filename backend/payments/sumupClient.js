import { isOffline } from '../appMode.js';
import { getPaymentSettingsForUse } from '../paymentSettings/repository.js';

const API = 'https://api.sumup.com/v0.1';
const CHECKOUT_ID = /^[A-Za-z0-9-]{1,64}$/;

// null while SumUp is not fully configured (or on the offline Con instance).
export async function getSumupConfig() {
  if (isOffline()) return null;
  const { sumupApiKey, sumupMerchantCode, sumupWebhookSecret, sumupEnabled } = await getPaymentSettingsForUse();
  if (!sumupApiKey || !sumupMerchantCode || !sumupWebhookSecret) return null;
  // `enabled` is the admin's switch: it only decides whether NEW checkouts start (the webhook must keep working).
  return { apiKey: sumupApiKey, merchantCode: sumupMerchantCode, webhookSecret: sumupWebhookSecret, enabled: sumupEnabled };
}

async function call(config, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`SumUp API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Hosted checkout: the customer pays on SumUp's page; SumUp then calls
// `returnUrl` (our webhook) with the checkout id and sends the browser to `redirectUrl`.
export function createSumupCheckout(config, { reference, amountCents, description, returnUrl, redirectUrl }) {
  return call(config, '/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      checkout_reference: reference,
      amount: Number((amountCents / 100).toFixed(2)),
      currency: 'EUR',
      merchant_code: config.merchantCode,
      description,
      return_url: returnUrl,
      redirect_url: redirectUrl,
      hosted_checkout: { enabled: true },
    }),
  });
}

// The webhook body is never trusted: the checkout is always re-read from SumUp.
export function getSumupCheckout(config, id) {
  if (typeof id !== 'string' || !CHECKOUT_ID.test(id)) throw new Error('invalid checkout id');
  return call(config, `/checkouts/${id}`);
}
