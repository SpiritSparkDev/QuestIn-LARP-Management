-- Stripe payment_intent id (needed to refund -- the checkout session id
-- alone is not refundable), plus refund bookkeeping. Refund state lives
-- entirely on the payments row, independent of registrations.paid_at/status
-- (see backend/registrations/statusMachine.js -- payment state and
-- registration status are already unrelated concepts in this schema).
ALTER TABLE payments ADD COLUMN stripe_payment_intent_id text;
ALTER TABLE payments ADD COLUMN stripe_refund_id text;
ALTER TABLE payments ADD COLUMN refunded_at timestamptz;
ALTER TABLE payments ADD COLUMN refund_amount_cents integer;
