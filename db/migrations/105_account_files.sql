-- Files attached to the account itself (not to a character); one of the
-- images can be the profile picture shown in the sidebar.
CREATE TABLE account_files (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'document')),
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  is_portrait boolean NOT NULL DEFAULT false,
  storage_backend text NOT NULL DEFAULT 'local',
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_files_user_id_idx ON account_files (user_id);
CREATE UNIQUE INDEX account_files_one_portrait_idx ON account_files (user_id) WHERE is_portrait;
