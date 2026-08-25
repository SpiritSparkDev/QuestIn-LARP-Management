CREATE TABLE events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event_date date not null,
  character_form_schema jsonb not null default '[]',
  created_at timestamptz not null default now()
);

CREATE TABLE characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

CREATE INDEX characters_user_id_idx ON characters (user_id);
CREATE INDEX characters_event_id_idx ON characters (event_id);
