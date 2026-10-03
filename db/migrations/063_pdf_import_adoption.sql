-- A PDF import can be turned into a guest account (is_guest, no password)
-- registered for an event -- see backend/pdfImport/adopt.js. These columns
-- record the outcome so the admin list can show it and retry failures.
ALTER TABLE pdf_imports ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pdf_imports ADD COLUMN event_id uuid REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE pdf_imports ADD COLUMN adopted_at timestamptz;
ALTER TABLE pdf_imports ADD COLUMN adopt_error text;
