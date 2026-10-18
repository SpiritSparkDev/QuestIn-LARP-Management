-- Add-on "Kinder": a person counts as a child for the extra registration fields when they are marked as a child
-- (users.is_child) or are younger than children_age_limit (from the birthdate, if one is known). The extra fields
-- are defined by the admin in child_field_schema (like registration_field_schema) and are filled in per child
-- by the guardian who registers them; the values live in the child's registration blob.
ALTER TABLE app_settings ADD COLUMN children_age_limit integer NOT NULL DEFAULT 16 CHECK (children_age_limit BETWEEN 1 AND 25);

CREATE TABLE child_field_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

INSERT INTO child_field_schema (schema) VALUES ('[
  {"key": "childPhotoInternal", "label": "Als Sorgeberechtigte/r willige ich ein, dass Fotos dieses Kindes aufgenommen und im passwortgeschützten Bereich gespeichert werden", "type": "boolean", "required": false},
  {"key": "childPhotoPublic", "label": "Als Sorgeberechtigte/r willige ich ein, dass Fotos, auf denen dieses Kind erkennbar ist, auf der öffentlichen Website veröffentlicht werden (ohne Namensnennung)", "type": "boolean", "required": false},
  {"key": "childVideo", "label": "Als Sorgeberechtigte/r willige ich ein, dass Videoaufnahmen mit diesem Kind angefertigt und gespeichert werden", "type": "boolean", "required": false}
]'::jsonb);

-- Admins and moderators may see and edit the new fields (other roles via the role settings).
UPDATE groups
   SET account_fields = account_fields || '["childPhotoInternal","childPhotoPublic","childVideo"]'::jsonb
 WHERE key IN ('admin', 'moderator');
