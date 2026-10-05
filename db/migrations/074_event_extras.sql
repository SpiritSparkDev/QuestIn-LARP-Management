-- Bookable extras (cabin, vehicle pitch, ...): the catalog lives on the event
-- as [{ id, name, description, priceCents, capacity }]; a registration stores
-- the booked quantities as { extraId: quantity } plus their total price, so a
-- later price change doesn't silently reprice what was already booked.
ALTER TABLE events ADD COLUMN extras jsonb NOT NULL DEFAULT '[]';
ALTER TABLE registrations ADD COLUMN extras jsonb NOT NULL DEFAULT '{}';
ALTER TABLE registrations ADD COLUMN extras_cents integer NOT NULL DEFAULT 0;
