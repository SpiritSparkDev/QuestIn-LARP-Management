# P5 Backup, Restore und Monitoring — Plan

**Bezug:** Empfehlung 5 (wichtigstes fehlendes Stück). Im Repo gibt es kein Backup; `docker-compose.yml` hat nur die Volumes `db-data` (Postgres) und `uploads-data` (`/app/uploads`).

## Was gesichert werden muss
| Was | Wo | Hinweis |
|---|---|---|
| Postgres-DB | Volume `db-data` | Enthält Personen-, Gesundheits-, Zahlungs- und Taverne-Daten. Ein Dump (`pg_dump -Fc`), nicht das Rohvolume kopieren. |
| Uploads | Volume `uploads-data` | Nur relevant bei Storage-Backend `local`. Bei `ftp`/`s3` liegen die Dateien extern (deren eigenes Backup/Versionierung prüfen). Logo/Hintergründe liegen ggf. in der DB (`app_settings`) — mit Dump abgedeckt. |
| **`ENCRYPTION_KEY`** | `.env` auf dem Server | Feldverschlüsselte Daten in der DB (`backend/crypto/fieldCrypto.js`, AES, 32 Byte) sind ohne ihn **unwiederbringlich**. Getrennt vom Datenbackup an einem sicheren Ort (Passwortmanager) ablegen, nie im gleichen Archiv wie die Dumps. |
| Restliche `.env`-Werte | Server | Ebenfalls im Passwortmanager (Postgres-Passwort, Stripe, SMTP, OAuth). |

## Ziele (zur Bestätigung)
- RPO: max. 24 h Datenverlust, vor/während Cons stündlich.
- RTO: Wiederherstellung auf frischem Server in < 1 h.
- Aufbewahrung: 7 tägliche, 4 wöchentliche, 6 monatliche Stände; zusätzlich ein Stand 30 Tage nach Event-Ende (Datenschutz: Löschfristen aus `backend/privacy` gelten auch für Backups → Aufbewahrungsdauer der Backups in der Datenschutzerklärung nennen; gelöschte Daten verschwinden spätestens nach Ablauf der Backup-Rotation).

## Schritt 1 — Backup-Skripte (`ops/`)
Neue Dateien, nicht im App-Image nötig (liegen im Repo, `ops/` ist nicht in `.dockerignore`, aber schadet nicht):
- `ops/backup.sh` (POSIX sh):
  1. `pg_dump -Fc "$DATABASE_URL" > $BACKUP_DIR/db-$(date +%F-%H%M).dump`
  2. Wenn `UPLOADS_DIR` vorhanden: `tar czf $BACKUP_DIR/uploads-….tar.gz -C "$UPLOADS_DIR" .`
  3. Prüfsumme (`sha256sum`) neben jede Datei, Dump mit `pg_restore -l` auf Lesbarkeit testen.
  4. Optional Verschlüsselung mit `age`/`gpg` (öffentlicher Schlüssel, privater nur im Passwortmanager) — Pflicht, sobald Offsite.
  5. Rotation nach Aufbewahrungsregel; Exit-Code ≠ 0 bei jedem Fehler.
  6. Erfolg → Heartbeat-Ping (siehe Monitoring).
- `ops/restore.sh <dump> [uploads.tar.gz]`: legt Ziel-DB neu an (`--clean --if-exists`), fragt vor dem Überschreiben nach (`--yes` für Skripte), spielt Uploads zurück, startet `npm run migrate` (falls Dump älter als Code).

## Schritt 2 — Backup als Compose-Dienst (Prod)
In `docker-compose.yml` einen Dienst `backup` ergänzen (Plesk-UI kennt kein `-f`, also muss er in der Standarddatei stehen):
- Image `postgres:16-alpine` (hat `pg_dump`), Skripte als read-only Bind-Mount oder per eigenem kleinen Dockerfile `ops/Dockerfile.backup`.
- Schleife/`crond` (Alpine `busybox crond`) mit `BACKUP_CRON` (Default `17 3 * * *`; vor einem Con stündlich umstellbar via Env).
- Volumes: `uploads-data:/data/uploads:ro`, Ziel `backups-data:/backups` (neues Volume) **und** optional Bind-Mount eines Host-Pfads (`BACKUP_HOST_DIR`), damit Plesks eigenes Server-Backup die Dateien miterfasst.
- `depends_on: db (healthy)`, `restart: unless-stopped`, keine Ports.
- `docker-compose.dev.yml`: kein Backup-Dienst (nur Hinweis in Doku, wie man `ops/backup.sh` lokal ausführt).

## Schritt 3 — Offsite-Kopie (wichtig: gleicher Server ≠ Backup)
Eine der Optionen wählen, Empfehlung zuerst:
1. **S3-kompatibler Speicher** — `@aws-sdk/client-s3` ist schon Abhängigkeit (Storage-Backend `s3`); ein kleiner Node-Upload-Schritt in `ops/backup.js` kann dieselben Zugangsdaten-Mechanismen nutzen. Bucket mit Versionierung/Object-Lock, separates Konto/Key mit nur Schreibrecht.
2. **SFTP/FTP** — `basic-ftp` ist Abhängigkeit; Zielserver unabhängig vom Hosting.
3. **Plesk-Server-Backup** auf externes Ziel einschalten und `BACKUP_HOST_DIR` einbinden (am wenigsten Code, aber von Plesk-Konfiguration abhängig).
Entscheidung offen: welcher Speicher steht euch zur Verfügung?

## Schritt 4 — Wiederherstellungsprobe (Pflicht, nicht optional)
1. Frischer Zielort (lokal oder Wegwerf-Container): `docker compose -f docker-compose.dev.yml up db` + `ops/restore.sh`.
2. App starten, mit Admin anmelden, prüfen: Mitgliederzahl, ein Event mit Anmeldungen, ein Charakter mit Datei, verschlüsselte Felder lesbar (beweist, dass `ENCRYPTION_KEY` passt), Stripe-/SMTP-Einstellungen entschlüsselbar.
3. Zeit stoppen (RTO), Ergebnis in `docs/betrieb-backup.md` protokollieren. Wiederholen: nach jeder Änderung am Backup-Mechanismus und mindestens vor jedem Con.

## Schritt 5 — Monitoring
- **Uptime:** externer Dienst (z. B. UptimeRobot/Healthchecks.io/eigener Pinger) fragt `GET /health` alle 1–5 min. Der Endpunkt prüft schon `SELECT 1` (`backend/routes.js`).
- **Backup-Heartbeat:** `ops/backup.sh` ruft bei Erfolg eine „Dead-man's-switch"-URL auf (z. B. Healthchecks.io, Secret `BACKUP_PING_URL`); bleibt der Ping aus (>26 h), kommt die Warnung. Bei Fehler zusätzlich `…/fail`.
- **`/health` erweitern (klein, mit Test):** liefert zusätzlich `version` (aus `APP_VERSION`) und optional `migrations` (Anzahl/letzte Datei). Keine sensiblen Daten.
- **Disk:** Warnung bei >80 % Belegung (Backup-Volume + `/app/uploads`; es gibt schon `/admin/settings/storage/usage` für Uploads). Kann als Zeile im Backup-Skript laufen (`df`).
- **Docker-Healthcheck für `app`:** `healthcheck: wget -qO- http://127.0.0.1:3000/health` in `docker-compose.yml`, damit `restart` und Plesk den Zustand sehen.
- **Logs:** `LOG_LEVEL` bleibt; Docker-Log-Rotation (`logging: driver json-file, max-size/max-file`) in beiden Compose-Diensten setzen, damit Logs den Plattenplatz nicht füllen.

## Schritt 6 — Dokumentation
`docs/betrieb-backup.md`: Was/Wo/Wie oft, wie Restore geht (Befehle), wo der `ENCRYPTION_KEY` liegt, Probeprotokoll, Ansprechpartner. In `CLAUDE.md` einen Zweizeiler zum Backup-Dienst (Prod-Compose) ergänzen.

## Tests
- `tests/unit/` für reine Rotationslogik, falls in Node (`ops/backup.js`) umgesetzt; Shell-Skripte per `shellcheck` (in CI, siehe P6).
- `/health`-Erweiterung: Integrationstest (Status 200, `status:'ok'`, `version` entspricht `APP_VERSION`).
- Restore-Probe ist manuell/Checkliste (Schritt 4).

## Abnahme
- Backup lief mindestens 3 Nächte automatisch, Heartbeat grün; Offsite-Kopie liegt vor; **erfolgreiche Wiederherstellung auf frischem System dokumentiert**; Uptime-Alarm einmal absichtlich ausgelöst und empfangen.

## Reihenfolge / Aufwand
Vor P3-Korrekturen und vor jeder Prod-Migration. ~1,5–2 Tage (Skripte 0,5, Compose/Offsite 0,5–1, Probe + Doku 0,5). Versionswirkung: `feat:` für den Backup-Dienst/`/health`-Erweiterung → MINOR-Bump am Tag des Commits (CLAUDE.md-Schema); Docs `docs:`.
