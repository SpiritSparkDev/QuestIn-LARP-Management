-- "Con-Zahler": pays at the con, the ticket is issued anyway (marked on the ticket).
ALTER TABLE registrations ADD COLUMN con_payer boolean NOT NULL DEFAULT false;
-- Registrations created from an imported PDF form stay open until paid; the orga gets reminders.
ALTER TABLE registrations ADD COLUMN pdf_import boolean NOT NULL DEFAULT false;
ALTER TABLE registrations ADD COLUMN unpaid_reminders_sent smallint NOT NULL DEFAULT 0;
-- Up to 3 entries: days after the registration on which reminder 1, 2, 3 is mailed to the orga.
ALTER TABLE app_settings ADD COLUMN unpaid_reminder_days integer[] NOT NULL DEFAULT '{}';
