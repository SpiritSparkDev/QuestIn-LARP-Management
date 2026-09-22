-- Needed to promote waitlisted registrations "oldest first" (task 5): there
-- was previously no column recording when a registration was created, so
-- FIFO order couldn't be determined at all.
ALTER TABLE registrations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
