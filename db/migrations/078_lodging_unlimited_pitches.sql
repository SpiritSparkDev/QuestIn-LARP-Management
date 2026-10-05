-- A tent-pitch lodging with 0 places is unlimited; bed lodgings still need at least one bed.
ALTER TABLE event_lodgings DROP CONSTRAINT IF EXISTS event_lodgings_beds_check;
ALTER TABLE event_lodgings ADD CONSTRAINT event_lodgings_beds_check
  CHECK ((kind = 'beds' AND beds >= 1) OR (kind = 'pitch' AND beds >= 0));
