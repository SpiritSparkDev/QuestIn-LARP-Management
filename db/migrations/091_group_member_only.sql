-- Accounts created through an e-mail group invitation are plain members: they
-- belong to the manager's group but may not manage anything in it.
ALTER TABLE users ADD COLUMN group_member_only boolean NOT NULL DEFAULT false;
