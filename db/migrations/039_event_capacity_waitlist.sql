ALTER TABLE events ADD COLUMN capacity integer;
ALTER TABLE app_settings ADD COLUMN waitlist_auto_promote boolean NOT NULL DEFAULT true;

ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check
  CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'waitlisted'));
