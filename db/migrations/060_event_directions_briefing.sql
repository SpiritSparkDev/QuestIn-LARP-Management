-- Optional, admin-maintained free text shown on the participant dashboard
-- only when non-empty (Anfahrtsbeschreibung / Plot & Briefing).
ALTER TABLE events ADD COLUMN directions text;
ALTER TABLE events ADD COLUMN briefing text;
