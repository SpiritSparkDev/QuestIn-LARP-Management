CREATE TABLE storage_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backend text NOT NULL DEFAULT 'local' CHECK (backend IN ('local', 'ftp', 's3')),
  ftp_host text,
  ftp_port integer,
  ftp_username text,
  ftp_password_enc bytea,
  ftp_secure boolean NOT NULL DEFAULT true,
  ftp_base_dir text,
  s3_bucket text,
  s3_region text,
  s3_endpoint text,
  s3_access_key_id text,
  s3_secret_access_key_enc bytea
);

ALTER TABLE character_files ADD COLUMN storage_backend text NOT NULL DEFAULT 'local'
  CHECK (storage_backend IN ('local', 'ftp', 's3'));
