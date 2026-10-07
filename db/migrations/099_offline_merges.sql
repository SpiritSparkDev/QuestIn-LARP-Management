-- Offline mode: every applied return package (one per snapshot + generation), so a
-- re-import is a no-op and the direct-sync token can only be used once per package.
CREATE TABLE offline_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  generation integer NOT NULL,
  mode text NOT NULL CHECK (mode IN ('final', 'interim', 'forced')),
  via_token boolean NOT NULL DEFAULT false,
  -- final merge with open conflicts: online is released once the last one is resolved
  pending_release boolean NOT NULL DEFAULT false,
  report jsonb NOT NULL,
  merged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, generation)
);

ALTER TABLE snapshot_log DROP CONSTRAINT snapshot_log_result_check;
ALTER TABLE snapshot_log ADD CONSTRAINT snapshot_log_result_check
  CHECK (result IN ('delegated', 'returned', 'aborted', 'forced', 'interim'));
