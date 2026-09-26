-- Liability-waiver text (admin-editable, versioned) plus a per-registration
-- record of which version a participant agreed to and when.
ALTER TABLE app_settings ADD COLUMN waiver_text text NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN waiver_version integer NOT NULL DEFAULT 1;

ALTER TABLE registrations ADD COLUMN waiver_version_accepted integer;
ALTER TABLE registrations ADD COLUMN waiver_accepted_at timestamptz;
