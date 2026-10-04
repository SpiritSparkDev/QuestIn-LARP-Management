-- Online top-ups (Stripe) are booked from a webhook that Stripe may deliver
-- more than once; the checkout session id makes each booking idempotent.
ALTER TABLE tavern_transactions ADD COLUMN provider_reference text;
CREATE UNIQUE INDEX tavern_transactions_provider_reference_idx
  ON tavern_transactions (provider_reference) WHERE provider_reference IS NOT NULL;
