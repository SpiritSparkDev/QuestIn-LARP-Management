-- Any image of a character can be chosen as its portrait (at most one).
-- Without a choice the first uploaded image is shown, as before.
ALTER TABLE character_files ADD COLUMN is_portrait boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX character_files_one_portrait_idx ON character_files (character_id) WHERE is_portrait;
