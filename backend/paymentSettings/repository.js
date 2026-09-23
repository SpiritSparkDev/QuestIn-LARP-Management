import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

export async function getPaymentSettings() {
  const { rows } = await query(
    `SELECT stripe_secret_key_enc IS NOT NULL AS has_stripe_secret_key,
            stripe_webhook_secret_enc IS NOT NULL AS has_stripe_webhook_secret,
            bank_iban, bank_bic, bank_account_holder
     FROM payment_settings LIMIT 1`
  );
  if (rows.length === 0) {
    return { hasStripeSecretKey: false, hasStripeWebhookSecret: false, bankIban: null, bankBic: null, bankAccountHolder: null };
  }
  return {
    hasStripeSecretKey: rows[0].has_stripe_secret_key,
    hasStripeWebhookSecret: rows[0].has_stripe_webhook_secret,
    bankIban: rows[0].bank_iban,
    bankBic: rows[0].bank_bic,
    bankAccountHolder: rows[0].bank_account_holder,
  };
}

export async function getBankInfo() {
  const { bankIban, bankBic, bankAccountHolder } = await getPaymentSettings();
  return { bankIban, bankBic, bankAccountHolder };
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
    'SELECT stripe_secret_key_enc, stripe_webhook_secret_enc FROM payment_settings LIMIT 1'
  );
  if (rows.length === 0) return { stripeSecretKey: null, stripeWebhookSecret: null };
  return {
    stripeSecretKey: safeDecrypt(rows[0].stripe_secret_key_enc),
    stripeWebhookSecret: safeDecrypt(rows[0].stripe_webhook_secret_enc),
  };
}

export async function setPaymentSettings({ stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder }) {
  const id = await ensureSettingsRow();
  const stripeSecretKeyEnc = stripeSecretKey ? encryptField(stripeSecretKey) : null;
  const stripeWebhookSecretEnc = stripeWebhookSecret ? encryptField(stripeWebhookSecret) : null;
  await query(
    `UPDATE payment_settings SET
       stripe_secret_key_enc = COALESCE($2, stripe_secret_key_enc),
       stripe_webhook_secret_enc = COALESCE($3, stripe_webhook_secret_enc),
       bank_iban = COALESCE($4, bank_iban),
       bank_bic = COALESCE($5, bank_bic),
       bank_account_holder = COALESCE($6, bank_account_holder)
     WHERE id = $1`,
    [id, stripeSecretKeyEnc, stripeWebhookSecretEnc, bankIban ?? null, bankBic ?? null, bankAccountHolder ?? null]
  );
  return getPaymentSettings();
}

async function ensureSettingsRow() {
  const { rows } = await query('SELECT id FROM payment_settings LIMIT 1');
  if (rows.length > 0) return rows[0].id;
  const { rows: inserted } = await query('INSERT INTO payment_settings DEFAULT VALUES RETURNING id');
  return inserted[0].id;
}
