-- Adds the new single-blob encrypted OT-field column for registrations.
-- See db/migrateRegistrationDataBlob.js for why the old 6 *_enc columns
-- are dropped there instead of here (needs ENCRYPTION_KEY-based
-- application crypto to backfill, not expressible in pure SQL).
ALTER TABLE registrations ADD COLUMN registration_data_enc bytea;
