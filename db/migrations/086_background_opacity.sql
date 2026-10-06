-- How strong the background graphic shows (percent).
ALTER TABLE app_settings ADD COLUMN background_opacity integer NOT NULL DEFAULT 20 CHECK (background_opacity BETWEEN 0 AND 100);
