-- Versandprotokoll: one row per attempt to send a system mail (see
-- backend/emailLog/repository.js), so an admin can tell "never sent" from
-- "sent, but lost in the recipient's spam folder". Rows are purged after 90
-- days by a background job. `user_id` is kept loosely (SET NULL) because the
-- recipient often isn't a users row yet (invitations, Orga addresses).
CREATE TABLE email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  slot text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  to_address text NOT NULL,
  subject text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'not_configured', 'skipped', 'queued')),
  error text
);
CREATE INDEX email_log_created_at_idx ON email_log (created_at DESC);
CREATE INDEX email_log_user_id_idx ON email_log (user_id);
CREATE INDEX email_log_to_address_idx ON email_log (lower(to_address));

-- Offline mails now carry what the online side needs to send and log them
-- after the handback (backend/emailLog/outbox.js).
ALTER TABLE mail_outbox ADD COLUMN slot text;
ALTER TABLE mail_outbox ADD COLUMN user_id uuid;
ALTER TABLE mail_outbox ADD COLUMN error text;

-- Invitations used to expire after 3 days -- too short: people opened the
-- mail a week later and found a dead link. Installs still on the old
-- default move to 14 days; a deliberately chosen other value stays.
ALTER TABLE app_settings ALTER COLUMN invitation_ttl_days SET DEFAULT 14;
UPDATE app_settings SET invitation_ttl_days = 14 WHERE invitation_ttl_days = 3;
