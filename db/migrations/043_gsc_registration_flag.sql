-- Correction to 042: GSC is a flag on an 'sc' registration, not its own
-- con_role -- mirrors the existing "sc + also available as NSC" bolt-on
-- (nsc_available) rather than reintroducing a separate con_role value.

ALTER TABLE registrations ADD COLUMN is_gsc boolean NOT NULL DEFAULT false;

UPDATE registrations SET is_gsc = true, con_role = 'sc' WHERE con_role = 'gsc';

ALTER TABLE registrations DROP CONSTRAINT registrations_character_con_role_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role = 'sc' AND character_id IS NOT NULL)
    OR (con_role = 'nsc')
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga') AND character_id IS NULL)
  );
