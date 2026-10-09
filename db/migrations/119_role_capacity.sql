-- Separate participant limits for SC and NSC (in addition to the total), and the admin's choice which
-- con roles count against the limits at all (crew roles do not by default).
ALTER TABLE events ADD COLUMN sc_capacity integer;
ALTER TABLE events ADD COLUMN sc_hard_capacity integer;
ALTER TABLE events ADD COLUMN nsc_capacity integer;
ALTER TABLE events ADD COLUMN nsc_hard_capacity integer;
ALTER TABLE app_settings ADD COLUMN capacity_counted_roles text[] NOT NULL DEFAULT '{sc,nsc,ticket}';
