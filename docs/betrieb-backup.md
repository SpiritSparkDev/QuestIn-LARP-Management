# Betrieb: Backup, Restore und Monitoring

Stand: 2026-10-08. Umsetzung von Plan P5 (`docs/superpowers/plans/2026-10-07-p5-backup-restore-monitoring.md`).

## Was gesichert wird
| Was | Wo | Wie |
|---|---|---|
| Postgres-Datenbank | Volume `db-data` | `pg_dump` im Custom-Format (`db-<Zeit>.dump`) |
| Uploads | Volume `uploads-data` (nur Storage-Backend `local`) | `uploads-<Zeit>.tar.gz` |
| **`ENCRYPTION_KEY`** | `.env` auf dem Server | **nicht im Backup.** Getrennt im Passwortmanager ablegen. Ohne ihn sind die feldverschlüsselten Daten (und gespeicherte Zugangsdaten für SMTP/Stripe/Speicher) auch mit intaktem Dump unlesbar. |
| Übrige `.env`-Werte | Server | ebenfalls im Passwortmanager (Postgres-Passwort, Stripe, SMTP, OAuth) |

Bei den Storage-Backends `ftp`/`s3` liegen die Dateien extern; deren Sicherung ist Sache des jeweiligen Anbieters.

## Der Backup-Dienst
Der Dienst `backup` in `docker-compose.yml` (Image aus `ops/Dockerfile.backup`, keine Bind-Mounts) führt `ops/backup.sh` per cron aus:
- Standard `17 3 * * *` (03:17 UTC), zusätzlich ein Lauf beim Containerstart (`BACKUP_ON_START=1`).
- Vor/während eines Cons stündlich: `BACKUP_CRON=17 * * * *` in `.env` setzen, Stack neu starten. Alle Stände des heutigen Tages bleiben erhalten.
- Prüfungen je Lauf: `pg_restore --list` (Dump lesbar), `tar -tzf` (Archiv lesbar), SHA-256-Datei daneben.
- Aufbewahrung: neuester Stand je Tag für `KEEP_DAILY` (7) Tage, je Woche für `KEEP_WEEKLY` (4) Wochen, je Monat für `KEEP_MONTHLY` (6) Monate, dazu alle Stände des laufenden Tages.
- Ablage im Volume `backups-data` (im Container `/backups`).
- Datenschutz: Gelöschte Daten verschwinden spätestens nach Ablauf der Rotation (bis zu ca. 6 Monate) aus den Backups. Das gehört in die Datenschutzerklärung.

### Verschlüsselung (empfohlen, Pflicht bei Offsite)
1. Schlüsselpaar lokal erzeugen: `age-keygen -o questin-backup.key`
2. Den öffentlichen Schlüssel (`age1…`) als `BACKUP_AGE_RECIPIENT` in `.env` eintragen.
3. Den privaten Schlüssel (`questin-backup.key`) in den Passwortmanager, **nicht** auf den Server.
Alle Dateien werden dann als `….age` abgelegt.

### Offsite-Kopie (gleicher Server ist kein Backup)
Per rclone, aktiviert durch `BACKUP_OFFSITE_REMOTE` (z. B. `offsite:mein-bucket/questin`). Remote `offsite` wird über Umgebungsvariablen konfiguriert, zum Beispiel S3-kompatibel:
```
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Other
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://s3.example.org
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=…
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=…
```
oder SFTP (`TYPE=sftp`, `HOST`, `PORT`, `USER`, `PASS` als `rclone obscure`-Wert). Der Zugang sollte nur Schreibrechte haben; Aufbewahrung/Versionierung am Ziel einstellen (Lifecycle-Regel), das Skript löscht dort nichts.

## Monitoring
- **Backup-Heartbeat:** `BACKUP_PING_URL` auf eine Dead-man's-switch-URL setzen (z. B. Healthchecks.io, Erwartung alle 24 h, Karenz 2 h; bei stündlichem Betrieb entsprechend). Erfolg ruft die URL auf, Fehler ruft `<URL>/fail` auf. Bleibt der Ping aus, kommt die Warnung.
- **Uptime:** externer Dienst fragt `GET /health` alle 1–5 Minuten. Antwort: `{"status":"ok","version":"x.y.z"}`; die Version zeigt auch, ob nach einem Deploy der neue Stand läuft.
- **Docker-Healthcheck** am Dienst `app` (`/health`), damit Docker/Plesk den Zustand sehen.
- **Plattenplatz:** das Skript warnt im Log ab `DISK_WARN_PERCENT` (80 %) Belegung des Backup-Volumes.
- **Log-Rotation:** alle drei Dienste begrenzen ihre Logs (10 MB × 5).

## Wiederherstellung
1. Stack stoppen, aber die Datenbank laufen lassen: `docker compose stop app`
2. Verfügbare Stände ansehen: `docker compose exec backup ls -l /backups`
3. Zurückspielen (DB und Uploads in einem Schritt; ohne `--yes` wird nachgefragt):
   ```
   docker compose exec backup /ops/restore.sh \
     /backups/db-<Zeit>.dump /backups/uploads-<Zeit>.tar.gz
   ```
   Bei verschlüsselten Dateien den privaten Schlüssel in den Container legen (z. B. `docker compose cp questin-backup.key backup:/tmp/key`) und `BACKUP_AGE_IDENTITY=/tmp/key` mitgeben (`docker compose exec -e BACKUP_AGE_IDENTITY=/tmp/key backup …`); danach den Schlüssel im Container wieder löschen.
   Die Datenbank wird in einer Transaktion ersetzt; bei einem Fehler bleibt der alte Stand. Prüfsummen werden vor dem Einspielen kontrolliert.
4. `docker compose up -d app`. Beim Start laufen die Migrationen, ein älterer Dump wird also auf den Code-Stand gebracht.
5. Auf **frischem Server:** `.env` mit **demselben `ENCRYPTION_KEY`** anlegen, `db` und `backup` starten, Dateien aus der Offsite-Kopie nach `/backups` kopieren, dann wie oben.

## Wiederherstellungsprobe (vor jedem Con und nach Änderungen am Mechanismus)
Auf einem Wegwerf-System (nie auf Produktion):
1. Frische Umgebung mit `docker compose -f docker-compose.dev.yml up db`, `ENCRYPTION_KEY` aus dem Passwortmanager.
2. Dump zurückspielen wie oben (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` passend setzen), App starten, als Admin anmelden.
3. Prüfen: Mitgliederzahl, ein Event mit Anmeldungen, ein Charakter mit Datei, feldverschlüsselte Daten lesbar (beweist den Schlüssel), SMTP-/Stripe-Einstellungen entschlüsselbar.
4. Dauer messen (Ziel unter 1 Stunde) und hier eintragen.

| Datum | Wer | Stand | Dauer | Ergebnis |
|---|---|---|---|---|
| _offen_ | | | | Probe noch nicht durchgeführt |

## Befehle von Hand
```
docker compose exec backup /ops/backup.sh          # sofort ein Backup
docker compose logs backup                          # Verlauf
```
