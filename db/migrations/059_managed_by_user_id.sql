ALTER TABLE users ADD COLUMN managed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX users_managed_by_user_id_idx ON users (managed_by_user_id) WHERE managed_by_user_id IS NOT NULL;

-- 'E-Mail optional': a managed person commonly has none (e.g. a small
-- child). NULL stays unique-safe (Postgres treats NULL <> NULL), and every
-- existing consumer only reads users.email for login/mail, neither of
-- which applies to an email-less managed person.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
