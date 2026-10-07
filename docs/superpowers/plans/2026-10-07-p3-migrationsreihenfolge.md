# P3 Migrationsreihenfolge prüfen und absichern — Plan

**Bezug:** `docs/offene-punkte.md` Punkt 16.

## Befund aus dem Repo
- `db/migrate.js` wendet alle `*.sql` **nach Dateiname sortiert** an und merkt sich den Dateinamen in `schema_migrations`. Fehlende Dateien werden nachgeholt, Reihenfolge der *Ausführung* auf einem Server hängt also davon ab, wann welche Datei dazukam.
- Doppelte Präfixe existieren weiterhin: `026_` (3×), `033_` (2×), `034_` (2×). Das frühere `067`-Problem ist entschärft (`067_stripe_bank_transfer_method.sql`, `070_group_can_export_members.sql`). Das Risiko: Eine Datei, die später als eine schon angewendete Datei mit höherem Präfix hinzukommt, läuft auf alten Servern *nach* dieser, auf frischen Servern *davor*.
- Letzte Migration: `085_background_preset.sql`.

## Ziel
1. Sicherstellen, dass alle Produktivserver schemagleich zu einer frisch migrierten DB sind.
2. Künftige Reihenfolge-Abweichungen automatisch verhindern.

## Schritt 1 — Bestandsaufnahme je Server (nur lesen)
Auf jedem Server (Plesk/Prod, ggf. Staging):
```sql
SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at, filename;
```
Ergebnis mit `ls db/migrations | sort` vergleichen:
- Fehlen Dateien? (dann `npm run migrate` – läuft beim Containerstart ohnehin)
- Stehen `067`–`070` und die Doppelpräfixe `026/033/034` in anderer `applied_at`-Reihenfolge als nach Namen? Dann prüfen, ob die betroffenen Migrationen voneinander abhängen (Spalte/Tabelle, die eine Datei anlegt und eine andere nutzt). Hier: `067` (Stripe/Überweisung) berührt Zahlungen, `070` fügt eine Gruppenspalte hinzu — voraussichtlich unabhängig, aber **verifizieren, nicht annehmen**.

## Schritt 2 — Schema-Vergleich (der eigentliche Beweis)
- Frische DB: `createdb ref && DATABASE_URL=…/ref npm run migrate`.
- Beide Schemata dumpen: `pg_dump --schema-only --no-owner --no-privileges` und mit `diff` vergleichen (Prod-Dump aus dem laufenden Container: `docker compose exec db pg_dump -U $POSTGRES_USER --schema-only …`).
- Erwartung: nur Reihenfolge-Rauschen. Echte Unterschiede (Spalte/Constraint/Default/Index fehlt) → korrigierende Migration `086_…sql` mit idempotentem SQL (`IF NOT EXISTS`), niemals bestehende Migrationsdateien editieren.

## Schritt 3 — Absicherung (Code, mit Tests)
- Neuer Unit-/Integrationstest `tests/integration/migrationFiles.test.js` (läuft ohne DB, nur Dateisystem):
  - Dateinamen entsprechen `^\d{3}_[a-z0-9_]+\.sql$`.
  - **Keine neuen** doppelten Präfixe: erlaubte Altlasten als feste Allowlist (`026`, `033`, `034`), jedes weitere Duplikat lässt den Test fehlschlagen.
  - Lückenlos: Präfixe ohne Sprünge bis zum Maximum.
- Neues Konvention-Stück in `CLAUDE.md` (eine Zeile): „Neue Migration = nächste freie dreistellige Nummer, nie ein bestehendes Präfix doppelt vergeben."
- Optional: `migrate.js` loggt beim Start eine Warnung, wenn ein *neu anzuwendender* Dateiname alphabetisch **vor** dem zuletzt angewendeten liegt (out-of-order), damit es im Log sichtbar wird.

## Schritt 4 — Dokumentation
- Ergebnis (je Server: „identisch" / „korrigiert mit 086") in `docs/offene-punkte.md`, Punkt 16 abhaken.

## Risiken
- Prod-Daten nicht verändern ohne vorheriges Backup → P5 zuerst oder wenigstens ein manueller `pg_dump` vor Schritt 2/Korrektur.

## Aufwand
~0,5 Tag (Vergleich + Test). Versionswirkung: Test/Docs `test:`/`docs:` → keine Änderung; Korrektur-Migration `fix:`.
