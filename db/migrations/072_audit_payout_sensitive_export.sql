-- 1. Audit log: who did what (staff-only character fields, CSV exports, ...).
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);

-- 2. Tavern: paying out a remaining balance after the event.
ALTER TABLE tavern_transactions DROP CONSTRAINT tavern_transactions_type_check;
ALTER TABLE tavern_transactions ADD CONSTRAINT tavern_transactions_type_check
  CHECK (type IN ('topup', 'charge', 'void', 'payout'));

-- 3. Sensitive account fields (e.g. health notes) in the CSV export need
-- their own permission on top of can_export_members.
ALTER TABLE groups ADD COLUMN can_export_sensitive boolean NOT NULL DEFAULT false;
UPDATE groups SET can_export_sensitive = true WHERE key IN ('admin', 'moderator');
