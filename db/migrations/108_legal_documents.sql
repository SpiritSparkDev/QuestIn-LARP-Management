-- Eigene Datenschutzerklaerung / eigenes Impressum: externe URL oder direkt eingegebener Text. NULL = nicht konfiguriert.
ALTER TABLE app_settings
  ADD COLUMN privacy_mode text CHECK (privacy_mode IN ('url', 'text')),
  ADD COLUMN privacy_url text,
  ADD COLUMN privacy_html text,
  ADD COLUMN imprint_mode text CHECK (imprint_mode IN ('url', 'text')),
  ADD COLUMN imprint_url text,
  ADD COLUMN imprint_html text;
