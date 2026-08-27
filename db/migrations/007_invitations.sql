CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text UNIQUE NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  group_id uuid NOT NULL REFERENCES groups(id),
  address_enc bytea,
  birthdate_enc bytea,
  phone_enc bytea,
  emergency_contact_enc bytea,
  medical_notes_enc bytea,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz
);

CREATE INDEX invitations_email_idx ON invitations (email) WHERE redeemed_at IS NULL;
