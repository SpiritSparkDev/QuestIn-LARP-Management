-- Deadline reminders are opt-in per registration; every mail carries an opt-out link built from this token.
ALTER TABLE registrations ADD COLUMN deadline_mail_optin boolean NOT NULL DEFAULT false;
ALTER TABLE registrations ADD COLUMN optout_token text UNIQUE;
