-- Light/dark theme + selectable color scheme for the whole instance (admin
-- Branding settings, applied to every visitor -- see frontend/css/sahara.css
-- and frontend/js/branding.js). color_scheme 'custom' ignores the built-in
-- palettes entirely and uses custom_colors instead (full admin-authored set
-- of the same CSS custom properties, see ALLOWED_CUSTOM_COLOR_KEYS in
-- backend/appSettings/routes.js).
ALTER TABLE app_settings ADD COLUMN theme_mode text NOT NULL DEFAULT 'light'
  CHECK (theme_mode IN ('light', 'dark'));
ALTER TABLE app_settings ADD COLUMN color_scheme text NOT NULL DEFAULT 'sahara'
  CHECK (color_scheme IN ('sahara', 'ozean', 'wald', 'hoehle', 'horror', 'custom'));
ALTER TABLE app_settings ADD COLUMN custom_colors jsonb;
