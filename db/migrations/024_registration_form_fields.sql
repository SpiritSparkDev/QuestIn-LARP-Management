ALTER TABLE users ADD COLUMN con_tage_enc bytea;
ALTER TABLE users ADD COLUMN accommodation_enc bytea;
ALTER TABLE users ADD COLUMN craft_offer_enc bytea;
ALTER TABLE users ADD COLUMN travel_method_enc bytea;
ALTER TABLE users ADD COLUMN data_sharing_opt_out_enc bytea;
ALTER TABLE users ADD COLUMN photo_opt_out_enc bytea;

ALTER TABLE invitations ADD COLUMN con_tage_enc bytea;
ALTER TABLE invitations ADD COLUMN accommodation_enc bytea;
ALTER TABLE invitations ADD COLUMN craft_offer_enc bytea;
ALTER TABLE invitations ADD COLUMN travel_method_enc bytea;
ALTER TABLE invitations ADD COLUMN data_sharing_opt_out_enc bytea;
ALTER TABLE invitations ADD COLUMN photo_opt_out_enc bytea;

UPDATE groups SET account_fields = account_fields || '["conTage","accommodation","craftOffer","travelMethod","dataSharingOptOut","photoOptOut"]'::jsonb
WHERE key IN ('admin', 'orga') AND NOT (account_fields @> '["conTage"]'::jsonb);
