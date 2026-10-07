-- capacity stays the advertised number; hard_capacity is the real waitlist limit.
ALTER TABLE events ADD COLUMN hard_capacity integer;
ALTER TABLE events ADD COLUMN low_seats_notice boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN low_seats_from integer;
