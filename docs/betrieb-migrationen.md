# Betrieb: Migrationen und Schemavergleich

Stand: 2026-10-08 (Plan P3).

## Wie Migrationen laufen
`npm run migrate` (beim Containerstart automatisch) wendet alle `db/migrations/*.sql` an, die in `schema_migrations` noch nicht stehen, **sortiert nach Dateiname**. Ein später hinzugekommenes Präfix, das vor einem schon angewendeten sortiert, läuft auf alten Servern also *nach* dieser Datei, auf frischen *davor*. `migrate.js` schreibt dafür die Warnung `out-of-order migration`.

Lokal (`docker-compose.dev.yml`) startet der Server über `backend/devServer.js` im Watch-Modus auf `backend/` und `db/migrations/`: Eine neue Migrationsdatei wird beim automatischen Neustart sofort eingespielt, ohne den Container neu zu starten. Schlägt sie fehl, steht `migration failed` im Log und der Server wartet, bis die Datei korrigiert ist.

## Befund (geprüft am 2026-10-08)
- Doppelte Präfixe aus der Frühzeit: `026` (3 Dateien), `033`, `034`, `085`, `086`, `090`, `091`, `092` (je 2). Letzte Migration: `096_nsc_als_rolle.sql`.
- Alle betroffenen Dateien betreffen verschiedene Tabellen/Spalten und hängen nicht voneinander ab.
- Beleg: Alle 105 Migrationen einmal in Namensreihenfolge und einmal mit **umgekehrter Reihenfolge innerhalb jeder Doppelgruppe** auf je eine frische Datenbank angewendet. Die normalisierten Schemata (485 Zeilen aus Spalten, Constraints, Indizes) sind **identisch**. Die Ausführungsreihenfolge innerhalb dieser Gruppen ist also egal.
- Neue Doppelpräfixe verhindert `tests/unit/migrationFiles.test.js` (Allowlist der acht alten Präfixe, Lückenprüfung, Namensformat).

## Server mit dem Sollstand vergleichen
Auf jedem Server (Prod, Staging):
```
# 1. Welche Migrationen sind in welcher Reihenfolge gelaufen?
docker compose exec db psql -U $POSTGRES_USER $POSTGRES_DB \
  -c "SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at, filename"

# 2. Schema-Fingerprint des Servers (aus dem Repo-Verzeichnis, Zugang zur DB nötig)
DATABASE_URL=postgres://… node scripts/schema-fingerprint.mjs | grep -v '^migration' > server.txt

# 3. Sollstand: frische Datenbank migrieren und dasselbe ausgeben
createdb ref
DATABASE_URL=postgres://…/ref ENCRYPTION_KEY=$(printf 'a%.0s' $(seq 64)) node db/migrate.js
DATABASE_URL=postgres://…/ref node scripts/schema-fingerprint.mjs | grep -v '^migration' > fresh.txt

diff fresh.txt server.txt && echo identisch
```
Leere Ausgabe von `diff` = Schema identisch (Spaltenreihenfolge wird bewusst ignoriert). Bei Unterschieden: korrigierende Migration mit der nächsten freien Nummer und idempotentem SQL (`IF NOT EXISTS`), keine bestehende Datei ändern. **Vor dem Eingriff ein Backup** (`docs/betrieb-backup.md`).

## Ergebnisse je Server
| Datum | Server | Ergebnis |
|---|---|---|
| _offen_ | Prod | Vergleich noch nicht durchgeführt |
