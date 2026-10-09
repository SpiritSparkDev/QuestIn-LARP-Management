-- Admin switch: participants can only pay online once the event has "Zahlungen freigeben" ticked.
ALTER TABLE events ADD COLUMN payments_open boolean NOT NULL DEFAULT false;
-- Existing events keep accepting payments as before.
UPDATE events SET payments_open = true;
