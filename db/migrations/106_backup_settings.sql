-- Zugangsdaten der Backup-Ziele (S3, SFTP) -- als ein verschluesselter Block, wie die uebrigen Zugangsdaten.
CREATE TABLE backup_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_enc bytea,
  updated_at timestamptz NOT NULL DEFAULT now()
);
