-- Optional add-on: generate a fillable registration PDF from the field schemas.
ALTER TABLE app_settings ADD COLUMN pdf_export_enabled boolean NOT NULL DEFAULT false;
