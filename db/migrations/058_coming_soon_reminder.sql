-- Marks a guest user row (see 046_guest_accounts.sql) as created via the
-- "Erinnere mich" form on the coming-soon page (frontend/coming-soon.html).
-- Cleared once the reminder invitation has been sent, so toggling
-- coming_soon_enabled off and back on never double-sends (see
-- backend/comingSoon/notify.js).
ALTER TABLE users ADD COLUMN coming_soon_reminder_requested_at timestamptz;
