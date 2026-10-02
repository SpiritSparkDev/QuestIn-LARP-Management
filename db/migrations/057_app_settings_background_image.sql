-- Global page background image, shown at 20% opacity behind all content
-- across the whole instance (see frontend/css/sahara.css and
-- frontend/js/branding.js), same storage shape as logo_data/ticket_bg_data.
ALTER TABLE app_settings ADD COLUMN background_image_data bytea;
ALTER TABLE app_settings ADD COLUMN background_image_mime_type text;
