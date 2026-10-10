-- Add-on "Kinder": a managed person (users.managed_by_user_id, the parent or
-- guardian) can be marked as a child. Children register as SC/NSC/... like
-- anyone else; the mark only adds a counter, filters and two rules
-- (backend/registrations/children.js): a child is registered only while the
-- guardian is registered for the same event, and children count against the
-- participant limits only if children_count_capacity is set.
ALTER TABLE users ADD COLUMN is_child boolean NOT NULL DEFAULT false;

ALTER TABLE app_settings ADD COLUMN children_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN children_count_capacity boolean NOT NULL DEFAULT false;
