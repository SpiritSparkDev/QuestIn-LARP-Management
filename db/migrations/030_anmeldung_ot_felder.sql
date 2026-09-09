-- 1. New encrypted columns on registrations for the 6 fields moving here
--    from account-wide storage (nullable, optional -- no backfill, existing
--    account-level values are discarded per the design decision).
ALTER TABLE registrations ADD COLUMN con_tage_enc bytea;
ALTER TABLE registrations ADD COLUMN accommodation_enc bytea;
ALTER TABLE registrations ADD COLUMN craft_offer_enc bytea;
ALTER TABLE registrations ADD COLUMN travel_method_enc bytea;
ALTER TABLE registrations ADD COLUMN data_sharing_opt_out_enc bytea;
ALTER TABLE registrations ADD COLUMN photo_opt_out_enc bytea;

-- 2. Drop the old account-wide columns -- no backfill, values discarded.
ALTER TABLE users
  DROP COLUMN con_tage_enc,
  DROP COLUMN accommodation_enc,
  DROP COLUMN craft_offer_enc,
  DROP COLUMN travel_method_enc,
  DROP COLUMN data_sharing_opt_out_enc,
  DROP COLUMN photo_opt_out_enc;

ALTER TABLE invitations
  DROP COLUMN con_tage_enc,
  DROP COLUMN accommodation_enc,
  DROP COLUMN craft_offer_enc,
  DROP COLUMN travel_method_enc,
  DROP COLUMN data_sharing_opt_out_enc,
  DROP COLUMN photo_opt_out_enc;
