-- Opt-in add-on "Tavernenkonto": prepaid accounts per event, a drinks menu
-- and a ledger of top-ups and charges.
ALTER TABLE app_settings ADD COLUMN tavern_enabled boolean NOT NULL DEFAULT false;

-- The menu (Getränkekarte) is global: prices carry over from event to event.
CREATE TABLE tavern_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

-- One account per participant (or walk-in) per event. "number" is the
-- tavern number staff and guests use; balance is kept in sync with the
-- ledger inside one transaction (see backend/tavern/repository.js).
CREATE TABLE tavern_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  number integer NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  label text,
  balance_cents integer NOT NULL DEFAULT 0,
  locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, number)
);
CREATE UNIQUE INDEX tavern_accounts_event_user_idx ON tavern_accounts (event_id, user_id) WHERE user_id IS NOT NULL;

-- amount_cents is signed: top-ups positive, charges negative, a void is the
-- exact opposite of the entry it reverses (reverses_id), which is then
-- marked voided_at.
CREATE TABLE tavern_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES tavern_accounts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('topup', 'charge', 'void')),
  amount_cents integer NOT NULL,
  method text,
  note text,
  items jsonb,
  reverses_id uuid REFERENCES tavern_transactions(id),
  voided_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tavern_transactions_account_idx ON tavern_transactions (account_id, created_at DESC);
