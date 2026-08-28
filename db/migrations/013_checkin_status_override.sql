ALTER TABLE groups ADD COLUMN can_override_checkin_status boolean NOT NULL DEFAULT false;

UPDATE groups SET can_override_checkin_status = true
WHERE key IN ('admin', 'orga', 'sl') AND can_override_checkin_status = false;
