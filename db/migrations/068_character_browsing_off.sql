-- Charakterübersicht ("Charaktere durchsuchen") ist vorerst abgeschaltet.
-- Der Admin-Schalter bleibt bestehen und kann sie wieder einschalten.
ALTER TABLE app_settings ALTER COLUMN character_browsing_enabled SET DEFAULT false;
UPDATE app_settings SET character_browsing_enabled = false;
