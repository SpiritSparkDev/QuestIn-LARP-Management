-- Gemeinsames Stammprofil aus dem QuestIn-Hub (Phase 4).
-- Zuordnung Hub-Schluessel -> lokales Kontofeld (account_field_schema.key).
-- Nicht zugeordnete Hub-Felder werden ignoriert.
CREATE TABLE hub_profile_mapping (
  hub_key text PRIMARY KEY,
  account_field_key text NOT NULL
);

-- Zuletzt vom Hub geholte Profildaten je Person und Kategorie (verschluesselt
-- wie die Kontodaten). Werden nur angeboten, nie automatisch uebernommen;
-- geloescht bei Widerruf, Hub-Kontoloeschung und nach der Frist der Kategorie
-- (PRIVACY_CATEGORIES: Gesundheit 28 Tage, sonst 180).
CREATE TABLE hub_profile_snapshots (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL,
  data bytea NOT NULL,
  hub_updated_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);
