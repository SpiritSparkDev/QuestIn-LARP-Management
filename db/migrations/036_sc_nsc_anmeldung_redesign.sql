-- GSC becomes a character-level flag instead of a per-registration con_role.
ALTER TABLE characters ADD COLUMN is_gsc boolean NOT NULL DEFAULT false;

-- Backfill: mark the character of every existing gsc registration as GSC,
-- then collapse con_role='gsc' into 'sc' (must run in this order -- the
-- UPDATE below would otherwise erase the con_role='gsc' rows the SELECT
-- above needs).
UPDATE characters SET is_gsc = true
WHERE id IN (SELECT character_id FROM registrations WHERE con_role = 'gsc');

UPDATE registrations SET con_role = 'sc' WHERE con_role = 'gsc';

-- New columns for the "sc + also available as NSC" case.
ALTER TABLE registrations ADD COLUMN nsc_available boolean NOT NULL DEFAULT false;
ALTER TABLE registrations ADD COLUMN nsc_character_id uuid REFERENCES characters(id);

-- Narrow the constraint: 'gsc' is gone, and 'nsc' no longer requires a
-- character_id (it becomes optional -- see backend/registrations/repository.js).
ALTER TABLE registrations DROP CONSTRAINT registrations_character_con_role_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role = 'sc' AND character_id IS NOT NULL)
    OR (con_role = 'nsc')
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga') AND character_id IS NULL)
  );
