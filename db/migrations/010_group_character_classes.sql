ALTER TABLE groups ADD COLUMN character_classes jsonb NOT NULL DEFAULT '[]';

UPDATE groups SET character_classes = '["nsc"]'::jsonb
WHERE key = 'nsc' AND NOT (character_classes @> '["nsc"]'::jsonb);

UPDATE groups SET character_classes = '["sc"]'::jsonb
WHERE key != 'nsc' AND NOT (character_classes @> '["sc"]'::jsonb);
