-- Datenschutz: per-event deletion rules (field -> data category, per category
-- mode + retention) and the user's consent to keep data for further events.
ALTER TABLE events ADD COLUMN privacy_deletion jsonb NOT NULL DEFAULT '{}';
-- { "<category>": "<ISO timestamp the deletion ran>" }
ALTER TABLE events ADD COLUMN privacy_deleted jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN keep_data_consent boolean NOT NULL DEFAULT false;
