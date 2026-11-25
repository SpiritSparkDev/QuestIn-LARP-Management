-- QuestIn-Verzeichnis, Feed v1.1 (Hub-Ausbau Phase 9): grobe Region statt
-- Adresse (die bleibt nur für Angemeldete, 061_event_location), Genres und
-- Anmeldestart. Platzstatus und Preis ab werden aus vorhandenen Daten berechnet.
ALTER TABLE events ADD COLUMN directory_region text;
ALTER TABLE events ADD COLUMN directory_genres text[] NOT NULL DEFAULT '{}';
ALTER TABLE events ADD COLUMN registration_opens_at timestamptz;
