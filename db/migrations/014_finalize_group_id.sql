INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, character_classes, can_override_checkin_status, is_protected)
VALUES
  ('admin', 'Admin', '["konto","charaktere","mitglieder","events","checkin"]'::jsonb, '["address","birthdate","phone","emergencyContact","medicalNotes","pronomen","group"]'::jsonb, true, '["sc"]'::jsonb, true, true),
  ('orga', 'Orga', '["konto","charaktere","mitglieder","events","checkin"]'::jsonb, '["address","birthdate","phone","emergencyContact","medicalNotes","pronomen"]'::jsonb, true, '["sc"]'::jsonb, true, false),
  ('plot_orga', 'Plot-Orga', '["konto","charaktere","events","checkin"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, false, false),
  ('sl', 'SL', '["konto","charaktere","checkin"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, true, false),
  ('hilfs_sl', 'Hilfs-SL', '["konto","charaktere","checkin"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, false, false),
  ('nsc', 'NSC', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, '["nsc"]'::jsonb, false, false),
  ('gsc', 'GSC', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, false, false),
  ('sc', 'SC', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, '["sc"]'::jsonb, false, false)
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role') THEN
    UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'admin') WHERE role = 'admin' AND group_id IS NULL;
    UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'sl') WHERE role = 'checkin_helper' AND group_id IS NULL;
    UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'sc') WHERE role = 'participant' AND group_id IS NULL;
    ALTER TABLE users ALTER COLUMN group_id SET NOT NULL;
    ALTER TABLE users DROP COLUMN role;
  END IF;
END $$;
