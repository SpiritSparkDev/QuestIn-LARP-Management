-- Admin-authored email templates. `subject`/`body` are Handlebars source,
-- rendered against a merge context built from a recipient's OT (account)
-- fields and, optionally, one of their IT (character) fields -- see
-- backend/emailTemplates/mergeFields.js. `is_html` picks which of
-- transporter.sendMail's `html`/`text` options the rendered body goes into.
CREATE TABLE email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  is_html boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
