-- Admin-definable per-event "flags" (special roles like GSC, VP,
-- Ersthelfer), and the subset of them each registration selects.
-- Generalizes the previous dedicated registrations.is_gsc bolt-on.
-- Note: is_gsc column remains for now; it will be dropped in a later task
-- when the registration code is fully migrated to use flags.

ALTER TABLE events ADD COLUMN flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE registrations ADD COLUMN flags text[] NOT NULL DEFAULT '{}';

-- GSC becomes a plain flag value instead of its own column: every event
-- with at least one is_gsc registration gets 'GSC' added to its flag
-- vocabulary, and every such registration gets flags=['GSC'].
UPDATE events e SET flags = ARRAY['GSC']
WHERE EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = e.id AND r.is_gsc = true);

UPDATE registrations SET flags = ARRAY['GSC'] WHERE is_gsc = true;
