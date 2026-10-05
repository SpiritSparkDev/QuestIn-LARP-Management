-- One lodging per event can be the default (typically the free tent pitch):
-- it is always shown in the registration; the others only after "Unterbringung mieten".
ALTER TABLE event_lodgings ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX event_lodgings_one_default_idx ON event_lodgings (event_id) WHERE is_default;
