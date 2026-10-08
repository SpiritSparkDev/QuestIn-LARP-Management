-- Idempotency key sent by the till/phone for each booking attempt. Repeating a
-- request (double tap, answer lost on a flaky network) with the same key must
-- not book twice. Null for entries without a key (storno, online top-up, old rows).
ALTER TABLE tavern_transactions ADD COLUMN request_id uuid;
CREATE UNIQUE INDEX tavern_transactions_request_idx ON tavern_transactions (account_id, request_id) WHERE request_id IS NOT NULL;
