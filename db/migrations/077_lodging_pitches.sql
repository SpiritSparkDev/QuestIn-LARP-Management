-- Tent pitches next to beds: a lodging is either a place with beds (hut, room,
-- tent with beds) or a pitch for a tent the participant brings. A pitch booking
-- records the tent: { lengthCm, widthCm, tentType: 'it' | 'ot' }.
ALTER TABLE event_lodgings ADD COLUMN kind text NOT NULL DEFAULT 'beds' CHECK (kind IN ('beds', 'pitch'));
ALTER TABLE registrations ADD COLUMN lodging_details jsonb;
