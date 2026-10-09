import crypto from 'node:crypto';
import { query } from '../db.js';
import { isOffline } from '../appMode.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

// Stripe payment methods an admin can switch on (Stripe's own payment_method_types names).
export const STRIPE_METHODS = ['card', 'paypal', 'bank_transfer', 'klarna', 'sepa_debit'];
const DEFAULT_STRIPE_METHODS = ['card', 'paypal', 'bank_transfer'];

export async function getPaymentSettings() {
  const { rows } = await query(
    `SELECT stripe_secret_key_enc IS NOT NULL AS has_stripe_secret_key,
            stripe_webhook_secret_enc IS NOT NULL AS has_stripe_webhook_secret,
            bank_iban, bank_bic, bank_account_holder, bank_qr_enabled,
            sumup_api_key_enc IS NOT NULL AS has_sumup_api_key, sumup_merchant_code,
            paypal_secret_enc IS NOT NULL AS has_paypal_secret, paypal_client_id, paypal_sandbox, stripe_methods, contact_email,
            stripe_enabled, paypal_enabled, sumup_enabled, bank_enabled, paypal_me_url, paypal_me_enabled, paypal_buttons_enabled
     FROM payment_settings LIMIT 1`
  );
  if (rows.length === 0) {
    return { hasStripeSecretKey: false, hasStripeWebhookSecret: false, bankIban: null, bankBic: null, bankAccountHolder: null, bankQrEnabled: true, hasSumupApiKey: false, sumupMerchantCode: null, hasPaypalSecret: false, paypalClientId: null, paypalSandbox: false, stripeMethods: DEFAULT_STRIPE_METHODS, contactEmail: null, stripeEnabled: false, paypalEnabled: false, sumupEnabled: false, bankEnabled: false, paypalMeUrl: null, paypalMeEnabled: false, paypalButtonsEnabled: false };
  }
  return {
    hasStripeSecretKey: rows[0].has_stripe_secret_key,
    hasStripeWebhookSecret: rows[0].has_stripe_webhook_secret,
    bankIban: rows[0].bank_iban,
    bankBic: rows[0].bank_bic,
    bankAccountHolder: rows[0].bank_account_holder,
    bankQrEnabled: rows[0].bank_qr_enabled,
    hasSumupApiKey: rows[0].has_sumup_api_key,
    sumupMerchantCode: rows[0].sumup_merchant_code,
    hasPaypalSecret: rows[0].has_paypal_secret,
    paypalClientId: rows[0].paypal_client_id,
    paypalSandbox: rows[0].paypal_sandbox,
    stripeMethods: rows[0].stripe_methods,
    contactEmail: rows[0].contact_email,
    stripeEnabled: rows[0].stripe_enabled,
    paypalEnabled: rows[0].paypal_enabled,
    sumupEnabled: rows[0].sumup_enabled,
    bankEnabled: rows[0].bank_enabled,
    paypalMeUrl: rows[0].paypal_me_url,
    paypalMeEnabled: rows[0].paypal_me_enabled,
    paypalButtonsEnabled: rows[0].paypal_buttons_enabled,
  };
}

// What participants may see: only methods that are credentialed AND switched on -- never the credentials.
export async function getBankInfo() {
  const s = await getPaymentSettings();
  const online = !isOffline();
  const bankLive = s.bankEnabled && Boolean(s.bankIban);
  return {
    bankIban: bankLive ? s.bankIban : null,
    bankBic: bankLive ? s.bankBic : null,
    bankAccountHolder: bankLive ? s.bankAccountHolder : null,
    bankQrEnabled: s.bankQrEnabled,
    contactEmail: s.contactEmail,
    stripeMethods: s.stripeEnabled && s.hasStripeSecretKey && online ? s.stripeMethods : [],
    sumupEnabled: s.sumupEnabled && s.hasSumupApiKey && Boolean(s.sumupMerchantCode) && online,
    paypalEnabled: s.paypalEnabled && s.hasPaypalSecret && Boolean(s.paypalClientId) && online,
    // The client id is public by design (PayPal's script needs it in the browser); never the secret.
    paypalButtonsClientId: s.paypalButtonsEnabled && s.paypalEnabled && s.hasPaypalSecret && online ? s.paypalClientId : null,
    paypalMeUrl: s.paypalMeEnabled && s.paypalMeUrl ? s.paypalMeUrl : null,
  };
}

function safeDecrypt(buffer) {
  try {
    return decryptField(buffer);
  } catch {
    return null;
  }
}

export async function getPaymentSettingsForUse() {
  const { rows } = await query(
    'SELECT stripe_secret_key_enc, stripe_webhook_secret_enc, sumup_api_key_enc, sumup_merchant_code, sumup_webhook_secret_enc, paypal_client_id, paypal_secret_enc, paypal_sandbox, stripe_methods, stripe_enabled, paypal_enabled, sumup_enabled FROM payment_settings LIMIT 1'
  );
  if (rows.length === 0) return { stripeSecretKey: null, stripeWebhookSecret: null, sumupApiKey: null, sumupMerchantCode: null, sumupWebhookSecret: null, paypalClientId: null, paypalSecret: null, paypalSandbox: false, stripeMethods: DEFAULT_STRIPE_METHODS, stripeEnabled: false, paypalEnabled: false, sumupEnabled: false };
  return {
    stripeSecretKey: safeDecrypt(rows[0].stripe_secret_key_enc),
    stripeWebhookSecret: safeDecrypt(rows[0].stripe_webhook_secret_enc),
    sumupApiKey: safeDecrypt(rows[0].sumup_api_key_enc),
    sumupMerchantCode: rows[0].sumup_merchant_code,
    sumupWebhookSecret: safeDecrypt(rows[0].sumup_webhook_secret_enc),
    paypalClientId: rows[0].paypal_client_id,
    paypalSecret: safeDecrypt(rows[0].paypal_secret_enc),
    paypalSandbox: rows[0].paypal_sandbox,
    stripeMethods: rows[0].stripe_methods,
    // Switches: they gate starting NEW payments; webhooks/returns of running ones always work.
    stripeEnabled: rows[0].stripe_enabled,
    paypalEnabled: rows[0].paypal_enabled,
    sumupEnabled: rows[0].sumup_enabled,
  };
}

export async function setPaymentSettings({ stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder, bankQrEnabled, sumupApiKey, sumupMerchantCode, paypalClientId, paypalSecret, paypalSandbox, stripeMethods, contactEmail, stripeEnabled, paypalEnabled, sumupEnabled, bankEnabled, paypalMeUrl, paypalMeEnabled, paypalButtonsEnabled }) {
  const id = await ensureSettingsRow();
  const stripeSecretKeyEnc = stripeSecretKey ? encryptField(stripeSecretKey) : null;
  const stripeWebhookSecretEnc = stripeWebhookSecret ? encryptField(stripeWebhookSecret) : null;
  const paypalSecretEnc = paypalSecret ? encryptField(paypalSecret) : null;
  const sumupApiKeyEnc = sumupApiKey ? encryptField(sumupApiKey) : null;
  // Random per installation, created once; it is part of the URL SumUp calls.
  const sumupWebhookSecretEnc = encryptField(crypto.randomBytes(24).toString('hex'));
  await query(
    `UPDATE payment_settings SET
       stripe_secret_key_enc = COALESCE($2, stripe_secret_key_enc),
       stripe_webhook_secret_enc = COALESCE($3, stripe_webhook_secret_enc),
       bank_iban = COALESCE($4, bank_iban),
       bank_bic = COALESCE($5, bank_bic),
       bank_account_holder = COALESCE($6, bank_account_holder),
       bank_qr_enabled = COALESCE($7, bank_qr_enabled),
       sumup_api_key_enc = COALESCE($8, sumup_api_key_enc),
       sumup_merchant_code = COALESCE($9, sumup_merchant_code),
       sumup_webhook_secret_enc = COALESCE(sumup_webhook_secret_enc, $10),
       paypal_client_id = COALESCE($11, paypal_client_id),
       paypal_secret_enc = COALESCE($12, paypal_secret_enc),
       paypal_sandbox = COALESCE($13, paypal_sandbox),
       stripe_methods = COALESCE($14, stripe_methods),
       contact_email = CASE WHEN $15 THEN $16 ELSE contact_email END,
       stripe_enabled = COALESCE($17, stripe_enabled),
       paypal_enabled = COALESCE($18, paypal_enabled),
       sumup_enabled = COALESCE($19, sumup_enabled),
       bank_enabled = COALESCE($20, bank_enabled),
       paypal_me_url = CASE WHEN $21 THEN $22 ELSE paypal_me_url END,
       paypal_me_enabled = COALESCE($23, paypal_me_enabled),
       paypal_buttons_enabled = COALESCE($24, paypal_buttons_enabled)
     WHERE id = $1`,
    [id, stripeSecretKeyEnc, stripeWebhookSecretEnc, bankIban ?? null, bankBic ?? null, bankAccountHolder ?? null, typeof bankQrEnabled === 'boolean' ? bankQrEnabled : null,
      sumupApiKeyEnc, typeof sumupMerchantCode === 'string' && sumupMerchantCode.trim() ? sumupMerchantCode.trim() : null, sumupWebhookSecretEnc,
      typeof paypalClientId === 'string' && paypalClientId.trim() ? paypalClientId.trim() : null, paypalSecretEnc,
      typeof paypalSandbox === 'boolean' ? paypalSandbox : null, Array.isArray(stripeMethods) ? stripeMethods : null,
      typeof contactEmail === 'string', contactEmail?.trim() || null,
      ...[stripeEnabled, paypalEnabled, sumupEnabled, bankEnabled].map((v) => (typeof v === 'boolean' ? v : null)),
      typeof paypalMeUrl === 'string', paypalMeUrl?.trim() || null, typeof paypalMeEnabled === 'boolean' ? paypalMeEnabled : null,
      typeof paypalButtonsEnabled === 'boolean' ? paypalButtonsEnabled : null]
  );
  return getPaymentSettings();
}

async function ensureSettingsRow() {
  const { rows } = await query('SELECT id FROM payment_settings LIMIT 1');
  if (rows.length > 0) return rows[0].id;
  const { rows: inserted } = await query('INSERT INTO payment_settings DEFAULT VALUES RETURNING id');
  return inserted[0].id;
}
