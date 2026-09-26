-- Lets a guest (no session, no password) return to Stripe checkout via an
-- emailed link instead of the authenticated checkout-session route. NULL for
-- every non-guest registration -- fully inert for the existing flow.
ALTER TABLE registrations ADD COLUMN payment_token text UNIQUE;
ALTER TABLE registrations ADD COLUMN payment_token_expires_at timestamptz;
