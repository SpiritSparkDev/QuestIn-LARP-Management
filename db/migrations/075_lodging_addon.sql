-- Add-on "Unterkünfte": sleeping places of an event (hut, room, tent, ...),
-- each with a number of beds and an optional price per bed. A registration
-- books at most one bed in one of them.
ALTER TABLE app_settings ADD COLUMN lodging_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE event_lodgings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  beds integer NOT NULL CHECK (beds >= 1),
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  position integer NOT NULL DEFAULT 0,
  UNIQUE (event_id, name)
);

ALTER TABLE registrations ADD COLUMN lodging_id uuid REFERENCES event_lodgings(id) ON DELETE SET NULL;
ALTER TABLE registrations ADD COLUMN lodging_cents integer NOT NULL DEFAULT 0;
CREATE INDEX registrations_lodging_idx ON registrations (lodging_id) WHERE lodging_id IS NOT NULL;
