-- A group manager may register a person as SC before they have a character
-- ("Charakter folgt"); the person picks one afterwards.
ALTER TABLE registrations DROP CONSTRAINT registrations_character_con_role_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    con_role IN ('sc', 'nsc')
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga', 'ticket') AND character_id IS NULL)
  );
