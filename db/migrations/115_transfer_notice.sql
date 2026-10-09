-- A participant clicked "Ich habe überwiesen": staff should check the bank account soon.
ALTER TABLE registrations ADD COLUMN transfer_notified_at timestamptz;
