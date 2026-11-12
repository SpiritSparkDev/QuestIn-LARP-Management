-- Per special role (flag), keyed by the flag's name:
--   { "abbr": "ERS", "discount": { "type": "percent" | "amount" | "free", "value": 10 } }
-- abbr: up to 3 characters, shown instead of the name in the member list and check-in.
-- discount.value: percent (1-100) or cents; absent for "free".
ALTER TABLE events ADD COLUMN flag_settings jsonb NOT NULL DEFAULT '{}';
