-- Every email template is now written for exactly one system-email slot
-- (see backend/emailTemplates/slots.js) and can only be assigned there: the
-- same {{link}} placeholder is an invitation link in one slot and a
-- password-reset link in another, so a template reused across slots sent
-- mails whose text promised a different link than the one they carried.
-- NULL = legacy template not yet given a slot; it can't be assigned until
-- an admin picks one.
ALTER TABLE email_templates ADD COLUMN slot text;

-- Backfill from the current assignments: a template gets the
-- (alphabetically first) slot it is assigned to ...
UPDATE email_templates t
   SET slot = a.slot
  FROM (SELECT template_id, min(slot) AS slot FROM email_slot_assignments
         WHERE template_id IS NOT NULL GROUP BY template_id) a
 WHERE a.template_id = t.id;

-- ... and every further slot it is assigned to gets its own copy, so no
-- existing assignment changes what it sends. email_slot_assignments.slot is
-- the primary key, so the inserted copy's slot identifies its assignment.
WITH extra AS (
  SELECT a.slot, t.name, t.subject, t.body, t.is_html
    FROM email_slot_assignments a
    JOIN email_templates t ON t.id = a.template_id
   WHERE t.slot <> a.slot
), copies AS (
  INSERT INTO email_templates (name, subject, body, is_html, slot)
  SELECT name || ' (' || slot || ')', subject, body, is_html, slot FROM extra
  RETURNING id, slot
)
UPDATE email_slot_assignments a
   SET template_id = c.id
  FROM copies c
 WHERE a.slot = c.slot;
