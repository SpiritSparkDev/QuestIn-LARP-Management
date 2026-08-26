CREATE TABLE groups (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  visible_menus jsonb not null default '[]',
  account_fields jsonb not null default '[]',
  can_edit_characters boolean not null default false,
  is_protected boolean not null default false
);

ALTER TABLE users ADD COLUMN group_id uuid REFERENCES groups(id);
