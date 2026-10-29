-- Verwendungszweck-Vorlage fuer Ueberweisungen (Anzeige + Girocode), mit Platzhaltern
-- wie {code}, {vorname}, {rolle}. NULL = bisheriges Format "<Kennung> Vorname-Nachname".
ALTER TABLE payment_settings ADD COLUMN bank_reference_template text;
