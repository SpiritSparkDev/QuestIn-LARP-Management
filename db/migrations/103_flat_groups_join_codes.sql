-- Groups are flat now: a group is one manager plus their persons and members;
-- nobody belongs to a second group and members do not have groups of their own.
--
-- Legacy nesting is flattened: everyone whose group_parent_id points at someone
-- who is a member themselves is moved up to the top manager of that chain
-- (that manager's persons stay reachable through the one remaining level).
-- Pending invitations that would now be invalid (inviter or invitee already
-- is a member) are dropped.
DO $$
BEGIN
  FOR i IN 1..20 LOOP
    UPDATE users c SET group_parent_id = p.group_parent_id
    FROM users p
    WHERE c.group_parent_id = p.id AND p.group_parent_id IS NOT NULL AND p.group_parent_id <> c.id;
    EXIT WHEN NOT FOUND;
  END LOOP;
END $$;

DELETE FROM group_invitations
WHERE parent_user_id IN (SELECT id FROM users WHERE group_parent_id IS NOT NULL)
   OR child_user_id IN (SELECT id FROM users WHERE group_parent_id IS NOT NULL);

-- Join codes now belong to the group manager (not to the person joining) and
-- can be created, limited and deleted in any number. The old one-per-person
-- codes ("send to the manager above you") have no meaning any more.
DROP TABLE group_join_codes;
CREATE TABLE group_join_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  code_hint text NOT NULL,                 -- last 4 characters, to tell codes apart in the list
  expires_at timestamptz,                  -- NULL = unlimited
  max_redemptions integer CHECK (max_redemptions >= 1), -- NULL = unlimited
  redemptions integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_join_codes_manager_idx ON group_join_codes (manager_user_id);
