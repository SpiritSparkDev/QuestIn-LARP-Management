-- Optional: PayPal's own payment buttons (their script) on our payment dialog, besides the redirect.
ALTER TABLE payment_settings ADD COLUMN paypal_buttons_enabled boolean NOT NULL DEFAULT false;
