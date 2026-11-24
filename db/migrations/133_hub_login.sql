-- "Mit QuestIn anmelden": Login ueber den QuestIn-Hub (OpenID Connect).
-- Provider 'hub' zusaetzlich erlauben, alle bisherigen Werte (auch 'matrix' fuer Funke) bleiben.
ALTER TABLE oauth_accounts DROP CONSTRAINT oauth_accounts_provider_check;
ALTER TABLE oauth_accounts ADD CONSTRAINT oauth_accounts_provider_check
  CHECK (provider IN ('google', 'facebook', 'discord', 'matrix', 'hub'));

-- Ein lokales Konto ist hoechstens mit einem Hub-Konto verbunden.
CREATE UNIQUE INDEX oauth_accounts_one_hub_per_user ON oauth_accounts (user_id) WHERE provider = 'hub';

-- Offene Verknuepfungsanfragen: Hub-Login mit einer E-Mail, zu der es schon ein
-- lokales Konto gibt. Verknuepft wird erst nach Nachweis (lokales Passwort oder
-- Mail-Link), nie automatisch. Tokens nur als SHA-256-Hash gespeichert.
CREATE TABLE hub_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  email_token_hash text UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hub_sub text NOT NULL,
  return_to text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
