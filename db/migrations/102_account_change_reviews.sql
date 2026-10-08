-- Reviews now also cover account (Konto) fields changed by a group manager:
-- no character, but the person whose account data was changed.
ALTER TABLE character_change_reviews ALTER COLUMN character_id DROP NOT NULL;
ALTER TABLE character_change_reviews ADD COLUMN subject_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE character_change_reviews DROP CONSTRAINT character_change_reviews_column_name_check;
ALTER TABLE character_change_reviews ADD CONSTRAINT character_change_reviews_column_name_check
  CHECK (column_name IN ('data', 'nsc_data', 'account'));
