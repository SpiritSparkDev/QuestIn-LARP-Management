-- PayPal via the PayPal API (independent of Stripe): credentials, and the orders we created
-- so the return URL can capture and book them without trusting the browser.
ALTER TABLE payment_settings ADD COLUMN paypal_client_id text;
ALTER TABLE payment_settings ADD COLUMN paypal_secret_enc bytea;
ALTER TABLE payment_settings ADD COLUMN paypal_sandbox boolean NOT NULL DEFAULT false;

-- Which Stripe payment methods the admin offers (the former three stay the default).
ALTER TABLE payment_settings ADD COLUMN stripe_methods text[] NOT NULL DEFAULT '{card,paypal,bank_transfer}';

CREATE TABLE paypal_orders (
  order_id text PRIMARY KEY,
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount_cents integer NOT NULL,
  success_url text NOT NULL,
  cancel_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  captured_at timestamptz,
  FOREIGN KEY (user_id, event_id) REFERENCES registrations (user_id, event_id) ON DELETE CASCADE
);

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('stripe_card', 'stripe_paypal', 'stripe_bank_transfer', 'stripe_klarna', 'stripe_sepa_debit', 'bank_transfer', 'sumup', 'paypal'));
