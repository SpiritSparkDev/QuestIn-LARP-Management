-- Add-on "QuestIn-Hub": this instance connects itself to the hub. One row.
-- Private key and client secret are stored encrypted (ENCRYPTION_KEY).
CREATE TABLE hub_connection (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  hub_url text,
  status text NOT NULL DEFAULT 'off'
    CHECK (status IN ('off', 'verify-domain', 'confirm-email', 'review', 'active', 'rejected', 'blocked', 'disconnected')),
  status_detail text,
  private_key_enc bytea,
  public_key text,
  key_id text,
  application_id uuid,
  challenge text,
  org_name text,
  contact_email text,
  client_id text,
  client_secret_enc bytea,
  issuer text,
  connected_at timestamptz,
  last_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hub_connection (id) VALUES (true);
