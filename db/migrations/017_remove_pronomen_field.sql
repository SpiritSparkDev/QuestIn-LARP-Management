ALTER TABLE users DROP COLUMN pronomen_enc;
ALTER TABLE invitations DROP COLUMN pronomen_enc;
UPDATE groups SET account_fields = account_fields - 'pronomen' WHERE account_fields ? 'pronomen';
