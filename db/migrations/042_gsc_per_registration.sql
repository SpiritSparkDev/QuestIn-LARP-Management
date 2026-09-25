-- Revert 036: GSC goes back to being a per-registration con_role, not a
-- fixed character trait -- players want to bring the same character as
-- plain SC to one event and as GSC to another.

ALTER TABLE registrations DROP CONSTRAINT registrations_character_con_role_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role IN ('sc', 'gsc') AND character_id IS NOT NULL)
    OR (con_role = 'nsc')
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga') AND character_id IS NULL)
  );

-- Backfill: a character that was flagged is_gsc carries that intent into its
-- current sc registrations before the flag disappears.
UPDATE registrations r SET con_role = 'gsc'
FROM characters c
WHERE r.character_id = c.id AND c.is_gsc = true AND r.con_role = 'sc';

ALTER TABLE characters DROP COLUMN is_gsc;
