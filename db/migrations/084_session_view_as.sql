-- "Als [Rolle] betrachten": an admin session can show the tool as seen by another group.
ALTER TABLE sessions ADD COLUMN view_as_group_id uuid REFERENCES groups(id) ON DELETE SET NULL;
