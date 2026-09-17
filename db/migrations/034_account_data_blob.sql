-- Adds the new single-blob encrypted OT-field column. The 7 old per-field
-- *_enc columns are dropped by db/migrateAccountDataBlob.js instead of
-- here -- that script must decrypt each old column (needs ENCRYPTION_KEY,
-- application-level AES-256-GCM) before it's safe to drop them, which pure
-- SQL cannot do. Run `npm run migrate-account-data-blob` once after this
-- migration, before relying on the old columns being gone.
ALTER TABLE users ADD COLUMN account_data_enc bytea;
ALTER TABLE invitations ADD COLUMN account_data_enc bytea;
