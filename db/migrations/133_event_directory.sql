-- QuestIn-Hub, Phase 1 (Eventverzeichnis). directory_published: the event is
-- listed in the public feed the hub reads (/public/directory/events.json).
-- hub_directory_cache: the last directory fetched from the hub (HUB_URL), shown
-- to participants as "Events anderer Orgas"; kept when the hub is unreachable.
ALTER TABLE events ADD COLUMN directory_published boolean NOT NULL DEFAULT false;

CREATE TABLE hub_directory_cache (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  events jsonb NOT NULL DEFAULT '[]',
  fetched_at timestamptz,
  last_success_at timestamptz,
  last_error text
);
