-- SumUp online payments: credentials (API key encrypted) and a random secret
-- that is part of the webhook URL SumUp calls after a checkout.
ALTER TABLE payment_settings ADD COLUMN sumup_api_key_enc bytea;
ALTER TABLE payment_settings ADD COLUMN sumup_merchant_code text;
ALTER TABLE payment_settings ADD COLUMN sumup_webhook_secret_enc bytea;

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('stripe_card', 'stripe_paypal', 'stripe_bank_transfer', 'bank_transfer', 'sumup'));
