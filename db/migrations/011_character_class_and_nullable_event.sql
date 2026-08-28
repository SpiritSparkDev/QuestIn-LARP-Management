ALTER TABLE characters ADD COLUMN class text NOT NULL DEFAULT 'sc' CHECK (class IN ('sc', 'nsc'));
ALTER TABLE characters ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE characters ADD CONSTRAINT characters_class_event_check
  CHECK ((class = 'sc' AND event_id IS NOT NULL) OR (class = 'nsc' AND event_id IS NULL));
