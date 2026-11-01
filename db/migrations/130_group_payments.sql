-- One online payment for several people (group manager pays for managed persons / sub-group).
-- The provider only knows "G:<id>"; booking then happens per person from user_ids.
CREATE TABLE group_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  payer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A PayPal order belongs either to one registration or to a group payment.
ALTER TABLE paypal_orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE paypal_orders ADD COLUMN group_payment_id uuid REFERENCES group_payments (id) ON DELETE CASCADE;
ALTER TABLE paypal_orders ADD CONSTRAINT paypal_orders_owner_check
  CHECK (user_id IS NOT NULL OR group_payment_id IS NOT NULL);
