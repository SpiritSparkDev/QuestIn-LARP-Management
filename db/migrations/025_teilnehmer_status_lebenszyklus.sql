ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
UPDATE registrations SET status = 'pending' WHERE status = 'registered';
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check
  CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'));
ALTER TABLE registrations ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE invitations ADD COLUMN event_id uuid REFERENCES events(id);
ALTER TABLE invitations ADD COLUMN cancelled_at timestamptz;
