-- Admin-defined fields for groups (edited by the group manager under "Gruppeneinstellungen").
CREATE TABLE group_field_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);
ALTER TABLE users ADD COLUMN group_data jsonb NOT NULL DEFAULT '{}';
