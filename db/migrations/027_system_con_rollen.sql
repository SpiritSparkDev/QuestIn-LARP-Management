-- 1. con_role column on registrations (nullable first, backfilled below from
--    the pre-migration group of each registration's user).
ALTER TABLE registrations ADD COLUMN con_role text
  CHECK (con_role IN ('sc', 'nsc', 'gsc', 'helfer', 'orga', 'hilfs_orga'));

UPDATE registrations r SET con_role = sub.mapped
FROM (
  SELECT u.id AS user_id, CASE g.key
    WHEN 'sc' THEN 'sc'
    WHEN 'gsc' THEN 'gsc'
    WHEN 'nsc' THEN 'nsc'
    WHEN 'orga' THEN 'orga'
    WHEN 'plot_orga' THEN 'orga'
    WHEN 'sl' THEN 'orga'
    WHEN 'hilfs_sl' THEN 'hilfs_orga'
    WHEN 'admin' THEN 'orga'
  END AS mapped
  FROM users u JOIN groups g ON g.id = u.group_id
) sub
WHERE r.user_id = sub.user_id AND r.con_role IS NULL;

ALTER TABLE registrations ALTER COLUMN con_role SET NOT NULL;

-- Default new registrations to 'sc' (the historical default for a
-- self-service signup) so INSERT INTO registrations keeps working for
-- existing callers (registerForEvent, tests) without specifying con_role.
-- Task 2's registration endpoints are expected to override this with real
-- per-registration logic; this default only covers the gap until then.
ALTER TABLE registrations ALTER COLUMN con_role SET DEFAULT 'sc';

-- 2. New system-role groups (character_classes still exists at this point,
--    defaults to '[]' via its own column default so it doesn't need listing).
INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status, is_protected)
VALUES
  ('moderator', 'Moderator', '["konto","charaktere","mitglieder","events","checkin"]'::jsonb,
   '["address","birthdate","phone","emergencyContactLastName","emergencyContactFirstName","emergencyContactPhone","medicalNotes","conTage","accommodation","craftOffer","travelMethod","dataSharingOptOut","photoOptOut"]'::jsonb,
   true, true, false),
  ('mitglied', 'Mitglied', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, false, false)
ON CONFLICT (key) DO NOTHING;

-- 3. Remap users AND invitations off the 5 legacy non-admin groups before
--    deleting them (both tables have a NOT NULL FK to groups.id).
UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'moderator')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl'));

UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'mitglied')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('sc', 'gsc', 'nsc'));

UPDATE invitations SET group_id = (SELECT id FROM groups WHERE key = 'moderator')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl'));

UPDATE invitations SET group_id = (SELECT id FROM groups WHERE key = 'mitglied')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('sc', 'gsc', 'nsc'));

-- 4. Drop the now-orphaned legacy groups and the superseded column.
DELETE FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl', 'sc', 'gsc', 'nsc');

ALTER TABLE groups DROP COLUMN character_classes;
