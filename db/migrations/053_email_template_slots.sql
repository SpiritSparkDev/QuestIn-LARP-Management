-- Maps a fixed system-email "slot" (see backend/emailTemplates/slots.js) to
-- an admin-authored template. A slot with no row here (the common case)
-- keeps sending its hardcoded default text -- see
-- backend/emailTemplates/send.js's renderSlotEmail.
CREATE TABLE email_slot_assignments (
  slot text PRIMARY KEY,
  template_id uuid REFERENCES email_templates(id) ON DELETE SET NULL
);
