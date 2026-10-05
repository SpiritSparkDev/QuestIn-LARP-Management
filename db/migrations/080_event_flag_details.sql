-- Short description per special role (flag), keyed by the flag's name.
-- The order of events.flags is the display order.
ALTER TABLE events ADD COLUMN flag_details jsonb NOT NULL DEFAULT '{}';
