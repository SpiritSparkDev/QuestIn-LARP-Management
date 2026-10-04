-- Own permission for the CSV export of the member list. Off by default for
-- new groups; admins and moderators (who could always see this data) keep it.
ALTER TABLE groups ADD COLUMN can_export_members boolean NOT NULL DEFAULT false;
UPDATE groups SET can_export_members = true WHERE key IN ('admin', 'moderator');
