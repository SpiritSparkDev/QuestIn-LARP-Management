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
            paypal_secret_enc IS NOT NULL AS has_paypal_secret, paypal_client_id, paypal_sandbox, stripe_methods, contact_email
     FROM payment_settings LIMIT 1`
  );
  if (rows.length === 0) {
    return { hasStripeSecretKey: false, hasStripeWebhookSecret: false, bankIban: null, bankBic: null, bankAccountHolder: null, bankQrEnabled: true, hasSumupApiKey: false, sumupMerchantCode: null, hasPaypalSecret: false, paypalClientId: null, paypalSandbox: false, stripeMethods: DEFAULT_STRIPE_METHODS, contactEmail: null };
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
  };
}

export async function getBankInfo() {
  const { bankIban, bankBic, bankAccountHolder, bankQrEnabled, hasStripeSecretKey, hasSumupApiKey, sumupMerchantCode, hasPaypalSecret, paypalClientId, stripeMethods, contactEmail } = await getPaymentSettings();
  // Only whether SumUp is usable, never the credentials.
  const online = !isOffline();
  return {
    bankIban, bankBic, bankAccountHolder, bankQrEnabled, contactEmail,
    stripeMethods: hasStripeSecretKey && online ? stripeMethods : [],
    sumupEnabled: hasSumupApiKey && Boolean(sumupMerchantCode) && online,
    paypalEnabled: hasPaypalSecret && Boolean(paypalClientId) && online,
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
    'SELECT stripe_secret_key_enc, stripe_webhook_secret_enc, sumup_api_key_enc, sumup_merchant_code, sumup_webhook_secret_enc, paypal_client_id, paypal_secret_enc, paypal_sandbox, stripe_methods FROM payment_settings LIMIT 1'
  );
  if (rows.length === 0) return { stripeSecretKey: null, stripeWebhookSecret: null, sumupApiKey: null, sumupMerchantCode: null, sumupWebhookSecret: null, paypalClientId: null, paypalSecret: null, paypalSandbox: false, stripeMethods: DEFAULT_STRIPE_METHODS };
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
  };
}

export async function setPaymentSettings({ stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder, bankQrEnabled, sumupApiKey, sumupMerchantCode, paypalClientId, paypalSecret, paypalSandbox, stripeMethods, contactEmail }) {
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
       contact_email = CASE WHEN $15 THEN $16 ELSE contact_email END
     WHERE id = $1`,
    [id, stripeSecretKeyEnc, stripeWebhookSecretEnc, bankIban ?? null, bankBic ?? null, bankAccountHolder ?? null, typeof bankQrEnabled === 'boolean' ? bankQrEnabled : null,
      sumupApiKeyEnc, typeof sumupMerchantCode === 'string' && sumupMerchantCode.trim() ? sumupMerchantCode.trim() : null, sumupWebhookSecretEnc,
      typeof paypalClientId === 'string' && paypalClientId.trim() ? paypalClientId.trim() : null, paypalSecretEnc,
      typeof paypalSandbox === 'boolean' ? paypalSandbox : null, Array.isArray(stripeMethods) ? stripeMethods : null,
      typeof contactEmail === 'string', contactEmail?.trim() || null]
  );
  return getPaymentSettings();
}

async function ensureSettingsRow() {
  const { rows } = await query('SELECT id FROM payment_settings LIMIT 1');
  if (rows.length > 0) return rows[0].id;
  const { rows: inserted } = await query('INSERT INTO payment_settings DEFAULT VALUES RETURNING id');
  return inserted[0].id;
}
