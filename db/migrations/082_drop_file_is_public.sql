-- Character files are never shown to other participants any more; the
-- "public" flag is gone. Files are visible to the people who manage the character.
ALTER TABLE character_files DROP COLUMN is_public;
