import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getPaymentSettings, setPaymentSettings, getBankInfo, STRIPE_METHODS } from './repository.js';

// A plain PayPal.Me link: every participant's browser opens it.
const PAYPAL_ME = /^https:\/\/(www\.)?paypal\.me\/[A-Za-z0-9._-]{1,50}$/;
const SWITCHES = ['stripeEnabled', 'paypalEnabled', 'sumupEnabled', 'bankEnabled', 'paypalMeEnabled'];

router.get('/admin/settings/payments', requireAuth(requireAdminGroup(async () => {
  const settings = await getPaymentSettings();
  return { status: 200, body: settings };
})));

router.put('/admin/settings/payments', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder, bankQrEnabled, sumupApiKey, sumupMerchantCode, paypalClientId, paypalSecret, paypalSandbox, stripeMethods, contactEmail, stripeEnabled, paypalEnabled, sumupEnabled, bankEnabled, paypalMeUrl, paypalMeEnabled } = body;
  if (SWITCHES.some((key) => body[key] !== undefined && typeof body[key] !== 'boolean')) {
    return { status: 400, body: { error: `${SWITCHES.join(', ')} must be booleans` } };
  }
  if (paypalMeUrl !== undefined && (typeof paypalMeUrl !== 'string' || (paypalMeUrl.trim() !== '' && !PAYPAL_ME.test(paypalMeUrl.trim())))) {
    return { status: 400, body: { error: 'Der PayPal.Me-Link muss so aussehen: https://paypal.me/DeinName' } };
  }
  if (contactEmail !== undefined && (typeof contactEmail !== 'string' || (contactEmail.trim() !== '' && !/^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,}$/.test(contactEmail.trim())))) {
    return { status: 400, body: { error: 'contactEmail must be an e-mail address' } };
  }
  if (stripeMethods !== undefined && (!Array.isArray(stripeMethods) || stripeMethods.some((m) => !STRIPE_METHODS.includes(m)))) {
    return { status: 400, body: { error: `stripeMethods must be a list of: ${STRIPE_METHODS.join(', ')}` } };
  }
  if ((paypalClientId !== undefined && (typeof paypalClientId !== 'string' || paypalClientId.length > 300))
    || (paypalSecret !== undefined && (typeof paypalSecret !== 'string' || paypalSecret.length > 300))
    || (paypalSandbox !== undefined && typeof paypalSandbox !== 'boolean')) {
    return { status: 400, body: { error: 'invalid PayPal settings' } };
  }
  const saved = await setPaymentSettings({ stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder, bankQrEnabled, sumupApiKey, sumupMerchantCode, paypalClientId, paypalSecret, paypalSandbox, stripeMethods, contactEmail, stripeEnabled, paypalEnabled, sumupEnabled, bankEnabled, paypalMeUrl, paypalMeEnabled });
  return { status: 200, body: saved };
})));

router.get('/payment-settings', requireAuth(async () => {
  const bankInfo = await getBankInfo();
  return { status: 200, body: bankInfo };
}));
