-- Replaces the separate, expiring email_verification_tokens and
-- password_reset_tokens tables with a single permanent per-user token.
-- The same link now both confirms the email address and resets the
-- password; each use rotates it to a fresh value (see backend/auth/accessTokens.js).
ALTER TABLE users ADD COLUMN access_token text UNIQUE;

UPDATE users
SET access_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE is_guest = false;

DROP TABLE email_verification_tokens;
DROP TABLE password_reset_tokens;
