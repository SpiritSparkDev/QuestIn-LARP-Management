ALTER TABLE registrations ADD COLUMN amount_due_cents integer;
ALTER TABLE registrations ADD COLUMN paid_at timestamptz;

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('stripe_card', 'stripe_paypal', 'bank_transfer')),
  amount_cents integer NOT NULL,
  provider_reference text,
  confirmed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, event_id) REFERENCES registrations (user_id, event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX payments_provider_reference_idx ON payments (provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE payment_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_secret_key_enc bytea,
  stripe_webhook_secret_enc bytea,
  bank_iban text,
  bank_bic text,
  bank_account_holder text
);
