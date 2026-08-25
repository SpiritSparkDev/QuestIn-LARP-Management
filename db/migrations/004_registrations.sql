CREATE TABLE registrations (
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  status text not null default 'registered' check (status in ('registered', 'checked_in', 'checked_out')),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  primary key (user_id, event_id)
);

CREATE INDEX registrations_event_id_idx ON registrations (event_id);
