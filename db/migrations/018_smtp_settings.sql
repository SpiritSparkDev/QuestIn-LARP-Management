CREATE TABLE smtp_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host text,
  port integer,
  username text,
  password_enc bytea,
  from_address text
);
