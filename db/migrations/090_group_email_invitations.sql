-- Group invitations to an e-mail address without an account yet: the link in
-- the mail opens a sign-up form; redeeming it creates the account directly
-- below the inviting manager.
ALTER TABLE group_invitations
  ALTER COLUMN child_user_id DROP NOT NULL,
  ADD COLUMN email text,
  ADD COLUMN token text UNIQUE,
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT group_invitations_target CHECK (child_user_id IS NOT NULL OR (email IS NOT NULL AND token IS NOT NULL AND expires_at IS NOT NULL));
CREATE UNIQUE INDEX group_invitations_parent_email_idx ON group_invitations (parent_user_id, lower(email)) WHERE email IS NOT NULL;
