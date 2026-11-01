-- Verwendungszweck-Vorlage fuer Sammelueberweisungen eines Gruppenverwalters
-- (Platzhalter wie {zahler}, {personen}, {anzahl}). NULL = Standardformat.
ALTER TABLE payment_settings ADD COLUMN bank_group_reference_template text;
