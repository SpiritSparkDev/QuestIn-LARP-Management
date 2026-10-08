-- Offline mode (APP_MODE=offline): outgoing mails are parked here instead of being sent.
CREATE TABLE mail_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address text NOT NULL,
  from_address text,
  subject text NOT NULL,
  body text NOT NULL,
  is_html boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
