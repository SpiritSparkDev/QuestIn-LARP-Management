-- A change to a character made by someone other than its owner (group manager,
-- staff) is recorded here; the owner sees it on the dashboard and either
-- accepts it or rejects it (rejecting restores the previous values).
CREATE TABLE character_change_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  column_name text NOT NULL CHECK (column_name IN ('data', 'nsc_data')),
  -- [{ key, label, from, to }]; key 'name' is the character name itself
  changes jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX character_change_reviews_pending ON character_change_reviews (owner_id) WHERE status = 'pending';
