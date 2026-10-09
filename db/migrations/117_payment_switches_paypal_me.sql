-- Each payment method gets its own on/off switch, so credentials can be saved ahead of going live.
ALTER TABLE payment_settings ADD COLUMN stripe_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN paypal_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN sumup_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN bank_enabled boolean NOT NULL DEFAULT false;

-- PayPal.Me for a private PayPal account (no API, so staff confirm the payment by hand).
ALTER TABLE payment_settings ADD COLUMN paypal_me_url text;
ALTER TABLE payment_settings ADD COLUMN paypal_me_enabled boolean NOT NULL DEFAULT false;

-- Whatever is already set up keeps running.
UPDATE payment_settings SET
  stripe_enabled = (stripe_secret_key_enc IS NOT NULL),
  paypal_enabled = (paypal_secret_enc IS NOT NULL AND paypal_client_id IS NOT NULL),
  sumup_enabled = (sumup_api_key_enc IS NOT NULL AND sumup_merchant_code IS NOT NULL),
  bank_enabled = (bank_iban IS NOT NULL);
