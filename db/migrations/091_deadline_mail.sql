-- Deadline for which the guest was already mailed (one mail per deadline).
ALTER TABLE registrations ADD COLUMN deadline_mail_for date;
