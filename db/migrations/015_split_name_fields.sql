ALTER TABLE users ADD COLUMN first_name text;
ALTER TABLE users ADD COLUMN last_name text;
ALTER TABLE users ADD COLUMN nickname text;
UPDATE users SET
  first_name = CASE WHEN position(' ' in name) = 0 THEN name ELSE substring(name from 1 for position(' ' in name) - 1) END,
  last_name = CASE WHEN position(' ' in name) = 0 THEN '' ELSE substring(name from position(' ' in name) + 1) END;
ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE users ALTER COLUMN last_name SET NOT NULL;
ALTER TABLE users DROP COLUMN name;

ALTER TABLE invitations ADD COLUMN first_name text;
ALTER TABLE invitations ADD COLUMN last_name text;
ALTER TABLE invitations ADD COLUMN nickname text;
UPDATE invitations SET
  first_name = CASE WHEN position(' ' in name) = 0 THEN name ELSE substring(name from 1 for position(' ' in name) - 1) END,
  last_name = CASE WHEN position(' ' in name) = 0 THEN '' ELSE substring(name from position(' ' in name) + 1) END;
ALTER TABLE invitations ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE invitations ALTER COLUMN last_name SET NOT NULL;
ALTER TABLE invitations DROP COLUMN name;
