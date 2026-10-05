-- Nested groups: a group manager (a full account) can belong to another
-- manager's group. The link only exists after the invited manager accepted.
ALTER TABLE users ADD COLUMN group_parent_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX users_group_parent_id_idx ON users (group_parent_id) WHERE group_parent_id IS NOT NULL;

CREATE TABLE group_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_user_id, child_user_id)
);

-- A manager can also hand a code to the manager above them: whoever enters it
-- adds that manager directly (creating the code is the consent). One live
-- code per manager; only its hash is stored.
CREATE TABLE group_join_codes (
  child_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL
);
