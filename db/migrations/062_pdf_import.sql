-- Optional add-on: read filled-in PDF forms (AcroForm) and store them.
ALTER TABLE app_settings ADD COLUMN pdf_import_enabled boolean NOT NULL DEFAULT false;

-- Single configuration row: the field list detected in the uploaded
-- template PDF, plus the admin's assignment of PDF fields to app fields.
CREATE TABLE pdf_import_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_filename text,
  pdf_fields jsonb NOT NULL DEFAULT '[]',
  mapping jsonb NOT NULL DEFAULT '{}',
  email_enabled boolean NOT NULL DEFAULT false
);

-- One row per imported PDF. Raw and mapped values hold personal data and
-- are stored encrypted, like account_data_enc.
CREATE TABLE pdf_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  source_filename text NOT NULL,
  raw_data_enc bytea NOT NULL,
  mapped_data_enc bytea NOT NULL,
  email_sent_at timestamptz,
  email_error text
);
