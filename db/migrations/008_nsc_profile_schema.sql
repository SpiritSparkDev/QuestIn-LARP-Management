CREATE TABLE nsc_profile_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

ALTER TABLE users ADD COLUMN nsc_data jsonb NOT NULL DEFAULT '{}';
