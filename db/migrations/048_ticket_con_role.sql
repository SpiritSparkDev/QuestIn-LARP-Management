-- New con_role for self-service guest tickets bought via the external
-- ticket widget -- distinct from 'helfer' (crew) and 'sc' (needs a
-- character): no character required, like helfer/orga/hilfs_orga.

ALTER TABLE registrations DROP CONSTRAINT registrations_con_role_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_con_role_check
  CHECK (con_role IN ('sc', 'nsc', 'gsc', 'helfer', 'orga', 'hilfs_orga', 'ticket'));

ALTER TABLE registrations DROP CONSTRAINT registrations_character_con_role_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role = 'sc' AND character_id IS NOT NULL)
    OR (con_role = 'nsc')
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga', 'ticket') AND character_id IS NULL)
  );
