-- Offline mode: which database may write check-in/tavern data. event_id NULL
-- is the instance identity row; one row per event holds that event's delegation.
CREATE TABLE instance_authority (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'delegated', 'offline_primary', 'retired')),
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid,
  snapshot_taken_at timestamptz,
  delegated_at timestamptz,
  delegated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  generation integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX instance_authority_identity ON instance_authority ((event_id IS NULL)) WHERE event_id IS NULL;

CREATE TABLE snapshot_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  snapshot_id uuid NOT NULL,
  generation integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  result text NOT NULL CHECK (result IN ('delegated', 'returned', 'aborted', 'forced'))
);

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  generation integer NOT NULL,
  type text NOT NULL,
  entity text NOT NULL,
  entity_id uuid,
  offline_value jsonb,
  online_value jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution text CHECK (resolution IN ('offline', 'online', 'merged', 'ignored')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
