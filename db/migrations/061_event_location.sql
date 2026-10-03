-- Optional event location, maintained by admins. Shown on the participant
-- dashboard only when set. maps_url / osm_url override the map links the
-- frontend would otherwise derive from the address.
ALTER TABLE events ADD COLUMN address text;
ALTER TABLE events ADD COLUMN maps_url text;
ALTER TABLE events ADD COLUMN osm_url text;
