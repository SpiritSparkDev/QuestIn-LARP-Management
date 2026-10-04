-- Farbintensive Varianten der eingebauten Farbschemata.
ALTER TABLE app_settings DROP CONSTRAINT app_settings_color_scheme_check;
ALTER TABLE app_settings ADD CONSTRAINT app_settings_color_scheme_check
  CHECK (color_scheme IN (
    'sahara', 'ozean', 'wald', 'hoehle', 'horror',
    'sahara-intensiv', 'ozean-intensiv', 'wald-intensiv', 'hoehle-intensiv', 'horror-intensiv',
    'custom'
  ));
