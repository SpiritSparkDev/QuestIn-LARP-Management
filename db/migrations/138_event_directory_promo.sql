-- QuestIn-Verzeichnis, Feed v1.2 (Schaufenster auf questin.de): Kurzbeschreibung
-- und Titelbild je Event. Der Hub lädt das Bild einmal über
-- /public/directory/events/:id/image und liefert es selbst aus.
ALTER TABLE events ADD COLUMN directory_teaser text;
ALTER TABLE events ADD COLUMN directory_image bytea;
ALTER TABLE events ADD COLUMN directory_image_type text;
ALTER TABLE events ADD COLUMN directory_image_updated_at timestamptz;
