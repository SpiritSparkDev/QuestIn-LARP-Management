-- Background graphic of the whole app: a built-in preset ('none' for no graphic) or
-- 'custom' (the uploaded image). An existing upload keeps being shown.
ALTER TABLE app_settings ADD COLUMN background_preset text NOT NULL DEFAULT 'grunge';
UPDATE app_settings SET background_preset = 'custom' WHERE background_image_data IS NOT NULL;
