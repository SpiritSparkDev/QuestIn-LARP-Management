ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('stripe_card', 'stripe_paypal', 'stripe_bank_transfer', 'bank_transfer'));
