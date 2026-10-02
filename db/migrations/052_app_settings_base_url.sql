-- Admin-overridable base URL for links in outgoing emails (verification,
-- password reset, invitations, guest ticket payment). NULL means "fall back
-- to the APP_BASE_URL env var" -- see backend/auth/mailer.js.
ALTER TABLE app_settings ADD COLUMN base_url text;
