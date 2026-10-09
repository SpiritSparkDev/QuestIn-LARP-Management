-- created_at stays the original registration time; the waitlist order uses waitlisted_at when staff moved a
-- registration back to the waitlist (before, created_at was overwritten for that).
ALTER TABLE registrations ADD COLUMN waitlisted_at timestamptz;
