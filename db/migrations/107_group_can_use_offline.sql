-- Welche Rollen die Datenbank offline verwenden duerfen (Online/Offline umschalten, Datenabgleich).
ALTER TABLE groups ADD COLUMN can_use_offline boolean NOT NULL DEFAULT false;
UPDATE groups SET can_use_offline = true WHERE key = 'admin';
