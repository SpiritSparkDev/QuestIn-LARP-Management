-- Admin-definable per-event pricing: named participant groups (e.g.
-- "Erwachsene", "Kinder") and named, dated price tiers (e.g.
-- "Frühbucher"/"Normalpreis") with one amount per group per tier. See
-- events.pricing's shape in backend/events/repository.js.
ALTER TABLE events ADD COLUMN pricing jsonb NOT NULL DEFAULT '{"groups": [], "tiers": []}'::jsonb;

-- price_group/price_tier are audit fields recording what was resolved at
-- registration time. price_list_cents is the tier amount before discount;
-- amount_due_cents (existing column) stays the authoritative amount to
-- charge, kept in sync with price_list_cents - discount_cents by the
-- application (see backend/payments/repository.js setDiscount).
ALTER TABLE registrations ADD COLUMN price_group text;
ALTER TABLE registrations ADD COLUMN price_tier text;
ALTER TABLE registrations ADD COLUMN price_list_cents integer;
ALTER TABLE registrations ADD COLUMN discount_cents integer NOT NULL DEFAULT 0;
