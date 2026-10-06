-- An admin ends the event; only then is Check-Out possible.
ALTER TABLE events ADD COLUMN ended_at timestamptz;
