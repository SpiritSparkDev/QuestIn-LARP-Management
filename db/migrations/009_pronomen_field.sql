ALTER TABLE users ADD COLUMN pronomen_enc bytea;
ALTER TABLE invitations ADD COLUMN pronomen_enc bytea;

UPDATE groups SET account_fields = account_fields || '["pronomen"]'::jsonb
WHERE key IN ('admin', 'orga') AND NOT (account_fields @> '["pronomen"]'::jsonb);
