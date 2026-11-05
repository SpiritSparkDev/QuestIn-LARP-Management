-- Bank group transfers (transfer notice) are remembered with their purpose text, so the
-- bank-statement reconciliation can match the incoming money to the selected people.
ALTER TABLE group_payments ADD COLUMN reference text;
ALTER TABLE group_payments ADD COLUMN kind text NOT NULL DEFAULT 'online' CHECK (kind IN ('online', 'bank'));
