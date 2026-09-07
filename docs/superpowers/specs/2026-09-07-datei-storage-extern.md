# Datei-Storage extern (FTP/S3) — Design

**Status:** Approved by user 2026-09-07, ready for plan decomposition.

## Kontext

`backend/characterFiles/routes.js` schreibt hochgeladene Charakter-Dateien
aktuell ausschließlich lokal auf die Platte (`UPLOADS_DIR`, per Docker-Volume
persistiert). Nutzerwunsch: Dateien optional auf externen Speicher (FTP oder
S3) auslagern können, admin-konfigurierbar, mit der Möglichkeit bereits
lokal liegende Dateien nachträglich zu migrieren und den Speicherverbrauch
pro Backend einzusehen.

Geklärt während des Brainstormings:
- Admin wählt EIN aktives Backend (`local`/`ftp`/`s3`) in den Einstellungen,
  kein gleichzeitiger Mehrfach-Versand.
- Bestehende Dateien bleiben auf ihrem ursprünglichen Backend liegen, auch
  nach einem Wechsel — nur neue Uploads gehen an das neu aktive Backend.
  Eine manuell angestoßene Migration kann bestehende Dateien nachträglich
  auf das aktuell aktive Backend verschieben.
- Downloads werden für alle drei Backends einheitlich durch die App proxied
  (kein S3-Presigned-URL-Redirect) — keine Sonderfälle im Frontend.
- Migration läuft synchron in einem Request (Spinner im Frontend), kein
  Hintergrund-Job-System.
- FTP nutzt FTPS (explizites TLS via `basic-ftp`s `secure: true`), kein
  Klartext-Fallback fest verdrahtet außer wenn der Server es erzwingt.

**Ein Plan** (kein Mehr-Plan-Initiative nötig — eine zusammenhängende
Änderung an einem bestehenden Feature, ähnlich groß wie die
SMTP-Konfiguration-Initiative).

---

## 1. Datenmodell

Migration `026_storage_backend.sql`:

```sql
CREATE TABLE storage_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  backend text NOT NULL DEFAULT 'local' CHECK (backend IN ('local', 'ftp', 's3')),
  ftp_host text,
  ftp_port integer,
  ftp_username text,
  ftp_password_enc bytea,
  ftp_secure boolean NOT NULL DEFAULT true,
  ftp_base_dir text,
  s3_bucket text,
  s3_region text,
  s3_endpoint text,
  s3_access_key_id text,
  s3_secret_access_key_enc bytea,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE character_files ADD COLUMN storage_backend text NOT NULL DEFAULT 'local'
  CHECK (storage_backend IN ('local', 'ftp', 's3'));
```

Gleiches Single-Row-Muster wie `smtp_settings`/`app_settings`
(`id boolean PRIMARY KEY DEFAULT true CHECK (id)`). Nur die beiden
Zugangsdaten-Geheimnisse (`ftp_password_enc`, `s3_secret_access_key_enc`)
werden verschlüsselt (`encryptField`/`decryptField` aus
`backend/crypto/fieldCrypto.js`) — Host/Port/User/Bucket/Region/Endpoint
sind nicht sensibel genug, gleiche Abwägung wie bei den bestehenden
Settings-Tabellen. `s3_access_key_id` bleibt unverschlüsselt (analog zu
`username` bei SMTP) — er ist ohne den Secret Key wertlos.

`character_files.storage_backend` wird beim Upload mit dem zu diesem
Zeitpunkt aktiven Backend gestempelt und danach nie automatisch geändert —
nur die Migration (siehe 4.) schreibt ihn um, nachdem die Datei tatsächlich
verschoben wurde.

## 2. Storage-Abstraktion

Neues Modul `backend/storage/`, ein File pro Backend, gleicher Stil wie
`backend/smtpSettings/`, `backend/characterFiles/`:

- `local.js` — `upload(id, buffer)`, `download(id)`, `remove(id)`,
  `testConnection()`. Nutzt weiterhin `UPLOADS_DIR` + `fs/promises`, 1:1 der
  aktuelle Code aus `characterFiles/routes.js`, nur verschoben.
- `ftp.js` — gleiche vier Funktionen, per `basic-ftp`. Jeder Aufruf öffnet
  eine neue `Client`-Verbindung (`access({host, port, user, password,
  secure: true})`), lädt/schreibt/löscht die Datei unter
  `${ftpBaseDir}/${id}` und schließt die Verbindung wieder — kein
  Connection-Pooling, bei dieser App-Größe nicht nötig.
  `testConnection(config)` macht ein `list(ftpBaseDir)` und wirft bei
  Fehlschlag mit der echten Client-Fehlermeldung.
- `s3.js` — gleiche vier Funktionen, per `@aws-sdk/client-s3`
  (`PutObjectCommand`/`GetObjectCommand`/`DeleteObjectCommand`,
  Objekt-Key = `id`, kein Präfix). Kein `@aws-sdk/lib-storage`/Multipart —
  das bestehende 20MB-Pro-Datei-Limit liegt weit unter S3s
  Single-PUT-Grenze von 5GB. `testConnection(config)` macht ein
  `HeadBucketCommand`.
- `index.js` — `getStorage(backendName, settings)`: gibt die vier
  Funktionen des passenden Moduls zurück, mit dem jeweiligen Backend-Teil
  von `settings` fest gebunden (kein globaler State, kein erneutes Lesen
  der DB pro Aufruf). `characterFiles/routes.js` ruft `getStorage(aktives
  Backend, settings)` für neue Uploads und `getStorage(file.storage_backend,
  settings)` für Lesen/Löschen einer bestehenden Datei — so bleibt eine auf
  FTP liegende Datei über FTP erreichbar, auch nachdem S3 aktiv wurde.

Neue Dependencies in `package.json`: `basic-ftp`, `@aws-sdk/client-s3`.

## 3. Settings-API + Admin-UI

Alle Routen admin-only (`requireAuth(requireAdminGroup(...))`), gleiches
Muster wie `backend/smtpSettings/routes.js`:

- `GET /admin/settings/storage` — aktuelle Einstellungen, Geheimnisse als
  `hasFtpPassword`/`hasS3SecretKey`-Flags statt Klartext.
- `PUT /admin/settings/storage` — speichert `{backend, ftp: {...}, s3:
  {...}}`; `ftpPassword`/`s3SecretAccessKey` optional (leer = bestehendes
  Geheimnis behalten, `COALESCE`-Pattern wie bei SMTP).
- `POST /admin/settings/storage/test` — nimmt die (ggf. ungespeicherten)
  Formulardaten direkt entgegen, ruft `testConnection()` des gewählten
  Backends auf, gibt bei Fehlschlag 502 mit der echten Fehlermeldung
  zurück (identisch zum SMTP-Test-Pattern).
- `GET /admin/settings/storage/usage` — `SELECT storage_backend,
  SUM(size_bytes) FROM character_files GROUP BY storage_backend`, liefert
  `{local: bytes, ftp: bytes, s3: bytes}` (0 für fehlende Gruppen) für das
  Balkendiagramm.
- `POST /admin/settings/storage/migrate` — synchron: lädt alle
  `character_files`-Zeilen, deren `storage_backend` vom aktuell aktiven
  Backend abweicht; pro Zeile: `download()` vom alten Backend,
  `upload()` auf das neue, `UPDATE character_files SET storage_backend =
  $2 WHERE id = $1`, dann `remove()` vom alten Backend (in dieser
  Reihenfolge — ein fehlgeschlagener Upload darf die alte Datei nicht
  verlieren). Fehler bei einer einzelnen Datei brechen die Migration nicht
  ab, sondern werden gesammelt; Antwort `{migrated: N, failed: [{id,
  error}]}` am Ende. Kein Zeitlimit-Handling über die normale
  HTTP-Request-Timeout-Konfiguration hinaus — bewusst kein Hintergrund-Job
  (siehe Kontext).

Neue Seite `frontend/admin/storage.html` (Nav-Eintrag `'speicher'`,
gehört wie Branding/Einstellungen/Gruppen zum admin-only Bereich,
hardcoded `group.key === 'admin'`-Sichtbarkeit statt einer konfigurierbaren
Menü-Berechtigung — gleiche Governance-Paradox-Begründung wie bei
`admin/groups.html`/`admin/settings.html`):
- Backend-Auswahl (Radio/Select Lokal/FTP/S3) mit bedingt eingeblendeten
  Feldern je Backend.
- „Verbindung testen"-Button (analog „Test-Mail senden").
- Balkendiagramm (Bytes pro Backend als einfaches Inline-SVG, wie andere
  Übersichten im Projekt — kein neues Chart-Package).
- „Migrieren"-Button: zeigt während der Anfrage einen Spinner, danach eine
  Zusammenfassung (`N migriert`, ggf. Liste der Fehlschläge).

## 4. Fehlerbehandlung

`characterFiles/routes.js` ersetzt seine drei direkten `fs.*`-Aufrufe durch
Aufrufe von `getStorage(...)`. Ein Fehlschlag beim Hochladen/Lesen/Löschen
gegen FTP oder S3 (Netzwerkproblem, falsche Zugangsdaten) wird als 502
(externer Dienst nicht erreichbar) beantwortet statt der bisherigen
404/500-Formen — ein Netzwerk-Hänger zu einem externen Host ist eine andere
Fehlerklasse als „Datei existiert nicht". Das bestehende
UUID-only-Dateinamensschema (structurally kein Path Traversal möglich)
bleibt unverändert, nur der Ziel-Ort ändert sich (`ftpBaseDir + '/' + id`
bzw. S3-Key `id` statt `UPLOADS_DIR/id`).

## 5. Testing

- Unit-Tests je Storage-Modul gegen einen Fake/Mock-Client (kein echter
  FTP-/S3-Server in CI) — gleiches Prinzip wie `tests/unit/mailer.test.js`s
  bestehendes Zero-Database/Zero-SMTP-Design.
- Integrationstests für Settings-CRUD/Migrate-Endpunkte mit `local` als
  Quell- UND Zielbackend (beweist Dispatch + DB-Bookkeeping ohne echte
  externe Zugangsdaten zu benötigen).
- Letzter Task des Plans: vollständiger `npm test`-Lauf (Projektstandard
  seit der Gruppen & Berechtigungen-Initiative).
