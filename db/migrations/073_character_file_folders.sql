-- Jeder Charakter bekommt einen eigenen Datei-Ordner im Speicher-Backend
-- (<character_id>/<file_id>). storage_key NULL = Altbestand, der noch flach
-- unter <file_id> liegt; er bleibt dort lesbar und wandert beim nächsten
-- Backend-Umzug in den Charakter-Ordner.
ALTER TABLE character_files ADD COLUMN storage_key text;

-- Die eigene "Dateien"-Seite entfällt: Uploads leben jetzt im Charakter.
UPDATE groups SET visible_menus = visible_menus - 'dateien'
WHERE visible_menus @> '["dateien"]'::jsonb;
