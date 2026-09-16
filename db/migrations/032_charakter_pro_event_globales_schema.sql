-- 1. Globales Charakter-Sheet-Schema für SC/GSC, ersetzt
--    events.character_form_schema -- mirrort nsc_profile_schema 1:1.
CREATE TABLE sc_character_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);

-- Startwert: character_form_schema des aktuell aktiven Events (falls
-- keins aktiv ist, bleibt das globale Schema leer -- ein Admin pflegt es
-- danach manuell über die neue admin/character-schema.html).
INSERT INTO sc_character_schema (schema)
SELECT COALESCE(
  (SELECT character_form_schema FROM events WHERE is_active = true LIMIT 1),
  '[]'::jsonb
);

-- 2. Mehrfach verlinkte SC-Charaktere aufsplitten: registrations hat
--    keine eigene id/created_at (Primärschlüssel ist (user_id, event_id),
--    siehe db/migrations/004_registrations.sql) -- Reihenfolge für "welche
--    Anmeldung behält das Original" kommt daher vom Event-Datum, nicht von
--    einem Anmelde-Zeitstempel: die Anmeldung zum am längsten
--    zurückliegenden Event behält den ursprünglichen Charakter-Datensatz,
--    jede weitere bekommt eine unabhängige Kopie (gleicher Name, gleicher
--    data-Stand zum Migrationszeitpunkt).
DO $$
DECLARE
  rec RECORD;
  new_id uuid;
BEGIN
  FOR rec IN
    SELECT r.user_id, r.event_id, r.character_id, c.name, c.data,
           ROW_NUMBER() OVER (PARTITION BY r.character_id ORDER BY e.event_date ASC) AS rn
    FROM registrations r
    JOIN characters c ON c.id = r.character_id AND c.class = 'sc'
    JOIN events e ON e.id = r.event_id
  LOOP
    IF rec.rn > 1 THEN
      INSERT INTO characters (user_id, class, name, data)
      VALUES (rec.user_id, 'sc', rec.name, rec.data)
      RETURNING id INTO new_id;

      UPDATE registrations SET character_id = new_id
      WHERE user_id = rec.user_id AND event_id = rec.event_id;
    END IF;
  END LOOP;
END $$;

-- 3. Jeden verbleibenden SC-Charakter auf das neu übernommene globale
--    Schema filtern (Felder aus Event-Schemas, die nicht dem des aktiven
--    Events entsprachen, werden verworfen).
UPDATE characters c
SET data = COALESCE((
  SELECT jsonb_object_agg(kv.key, kv.value)
  FROM jsonb_each(c.data) AS kv
  WHERE kv.key IN (
    SELECT elem->>'key' FROM sc_character_schema, jsonb_array_elements(schema) AS elem
  )
), '{}'::jsonb)
WHERE c.class = 'sc';

-- 4. events.character_form_schema ist durch sc_character_schema ersetzt.
ALTER TABLE events DROP COLUMN character_form_schema;
