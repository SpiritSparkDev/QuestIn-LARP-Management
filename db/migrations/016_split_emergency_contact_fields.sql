ALTER TABLE users ADD COLUMN emergency_contact_last_name_enc bytea;
ALTER TABLE users ADD COLUMN emergency_contact_first_name_enc bytea;
ALTER TABLE users ADD COLUMN emergency_contact_phone_enc bytea;
ALTER TABLE users DROP COLUMN emergency_contact_enc;

ALTER TABLE invitations ADD COLUMN emergency_contact_last_name_enc bytea;
ALTER TABLE invitations ADD COLUMN emergency_contact_first_name_enc bytea;
ALTER TABLE invitations ADD COLUMN emergency_contact_phone_enc bytea;
ALTER TABLE invitations DROP COLUMN emergency_contact_enc;

UPDATE groups SET account_fields = (account_fields - 'emergencyContact') || '["emergencyContactLastName", "emergencyContactFirstName", "emergencyContactPhone"]'::jsonb
WHERE account_fields ? 'emergencyContact';
