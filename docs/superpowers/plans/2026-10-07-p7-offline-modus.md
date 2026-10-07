# P7 Offline-Modus vor Ort (Check-in + Tavernenkonto) — Plan

**Anlass:** Auf dem Con ist das Netz unzuverlässig. Check-in und Taverne müssen ohne Internet laufen. Idee des Auftraggebers: Datenbank einmal herunterladen, als Offline-Version mit Zeitstempel markieren; die Online-Datenbank merkt sich ebenfalls, dass (und seit wann) eine Offline-Version existiert, damit immer nur die richtige Datenbank verwendet wird.

## Kernidee (bestätigt, präzisiert)
Das Prinzip „es gibt immer genau **eine schreibberechtigte** Datenbank" ist richtig und wird als **Übergabe (Lease)** umgesetzt:
1. Online wird für Check-in/Taverne **gesperrt („delegiert")** und merkt sich Snapshot-ID + Zeitstempel.
2. Die Offline-Instanz ist ab Import schreibberechtigt und trägt dieselbe Snapshot-ID.
3. Nach dem Con wird ein **Rückgabepaket** (nur die vor Ort geänderten Daten) online eingespielt; erst danach ist Online wieder schreibberechtigt.
Wer „zuerst angefasst" wurde, entscheidet also nicht ein Zeitvergleich, sondern der gespeicherte Zustand (`primary` / `delegated`) mit Snapshot-ID. Zeitstempel sind nur Anzeige und Plausibilitätsprüfung, weil Uhren abweichen.

## Architekturentscheidung: lokaler Con-Server statt Einzelgeräte-Offline
| | A) Lokaler Server (Laptop + WLAN) | B) PWA je Gerät (IndexedDB) |
|---|---|---|
| Code | Selbe App, selbes Schema (`docker-compose.dev.yml` bzw. eigenes Offline-Compose) | Zweite Client-Logik, Sync, Konfliktauflösung |
| Tavernenguthaben | Ein Konto, eine Wahrheit, harte Sperre ohne Dispo funktioniert | Zwei Geräte können dasselbe Konto überziehen → Konflikt, widerspricht „kein Dispo" |
| Check-in | Zwei Scanner sehen sofort denselben Stand | Doppel-Check-ins möglich |
| Ausfall | Laptop = Einzelpunkt (Ersatzlaptop mit zweitem Snapshot) | Jedes Gerät unabhängig |
**Empfehlung: A.** Hohe Konsistenz bei geringem Neuaufwand; B nur als optionales Zusatzrisiko-Netz später.

## Wichtige Stolperstellen
1. **HTTPS im lokalen Netz.** `getUserMedia` (QR-Scan) und Service Worker funktionieren nur im sicheren Kontext. `http://192.168.x.x` auf dem Handy erlaubt **keine Kamera**. Lösung: lokaler Caddy/nginx mit Zertifikat einer eigenen CA (mkcert o. ä., CA einmalig auf den Scan-Handys installieren) oder lokaler Hostname (`con.local`) mit Zertifikat. Muss im P1-Echtgerätetest geprüft werden. `backend/server.js` ist reines HTTP → TLS gehört in einen Reverse-Proxy davor.
2. **Sensible Daten auf dem Laptop.** Ein Voll-Dump enthält Personen-, Gesundheits- und Zahlungsdaten und braucht den `ENCRYPTION_KEY`. Entscheidung unten (Reduzierter Snapshot empfohlen). Mindestens: Passphrase-verschlüsselte Datei, Festplattenverschlüsselung, Löschen nach Rückgabe.
3. **Wer ist Eigentümer welcher Daten?** Konfliktfrei, wenn getrennt nach Tabellen:
   - **Offline schreibt:** Check-in-Status (`registrations.status`, `checked_in_at`, Check-in-Overrides), `tavern_accounts`, `tavern_transactions` (neue Konten/Walk-ins, Buchungen, Stornos, Auszahlungen, Sperren), Audit-Einträge.
   - **Online schreibt weiter:** Konten, Anmeldungen, Zahlungen, Mailings. Änderungen dort seit dem Snapshot erreichen die Offline-Instanz **nicht** (Anzeige „Stand vom …", z. B. späte Zahlung nicht sichtbar → Check-in fragt wie bisher bei Con-Zahler/offen nach).
   - Heißt: Die Rückgabe überschreibt nie Online-Daten außerhalb dieser Tabellen.
4. **Keine Online-Zahlungen in der Offline-Zeit** für Taverne (ist ohnehin entschieden: kein Online-Aufladen) → keine Zahlungs-Webhooks, die in die gesperrten Tabellen schreiben. Stripe-Webhooks für Anmeldungen laufen normal weiter.
5. **IDs sind UUID** → neue Datensätze offline kollidieren nicht. Ausnahme: `tavern_accounts.number` (`UNIQUE (event_id, number)`, fortlaufend). Offline neu vergebene Nummern können mit online (z. B. durch einen Gast-Account während der Delegation) vergebenen kollidieren → Nummernvergabe online in der Delegationszeit sperren **oder** Offline-Nummernband reservieren (z. B. ab 9000).

## Datenmodell (neue Migration, nächste freie Nummer, aktuell `086_instance_authority.sql`)
Einzeilige Tabelle `instance_authority`:
- `role` text: `primary` | `delegated` (online) | `offline_primary` | `retired` (Offline-Instanz nach Rückgabe)
- `event_id` uuid null (Delegation je Event; siehe offene Frage)
- `snapshot_id` uuid, `snapshot_taken_at` timestamptz, `delegated_at`, `delegated_by`
- `generation` integer (zählt jede Übergabe hoch, hilft beim Erkennen veralteter Pakete)
- `instance_id` uuid (zufällig je Datenbank beim ersten Start, damit jede Instanz sich selbst kennt)
Zusätzlich `snapshot_log` (Historie: wann, wer, Ergebnis `returned`/`aborted`/`forced`).

## Ablauf
### 1. Offline-Version erzeugen (online, Admin-Recht, neue Seite unter Einstellungen/Check-in)
- Vorbedingung: `role = primary` (sonst Meldung „bereits delegiert seit …, von …").
- Bestätigungsdialog: erklärt Sperre, Dauer, Datenschutzhinweis, verlangt **Passphrase** für die Dateiverschlüsselung.
- In einer Transaktion: `role='delegated'`, neue `snapshot_id`, Zeitstempel; Datenexport (Schritt unten) erzeugen; Manifest `{snapshot_id, taken_at, instance_id, schema_version = letzte Migration, generation}` mit HMAC signieren (Schlüssel aus `ENCRYPTION_KEY`, damit fremde/manipulierte Pakete abgelehnt werden).
- Download einer Datei `questin-offline-<event>-<datum>.qpkg` (verschlüsselt).

### 2. Online im Delegationszustand
- Globaler Guard in `backend/router.js`/Middleware für die Schreib-Routen der Offline-Domäne (`/events/:id/checkin*`, `/events/:id/checkout`, `/tavern/*` außer lesend): Antwort **423 Locked** mit Text „Check-in/Taverne laufen gerade offline (Snapshot vom …)". Lesende Ansichten bleiben.
- Prominenter Banner in der Admin-Oberfläche („Offline-Version aktiv seit …, Rückgabe ausstehend").
- Notfallweg „Delegation aufheben" (Admin, doppelte Bestätigung, protokolliert): setzt zurück auf `primary` und **entwertet** den Snapshot (spätere Rückgabepakete werden abgelehnt). Warnt vor Datenverlust der Offline-Buchungen.

### 3. Offline-Instanz einrichten (vor Ort / vorher)
- Selbe App-Version wie online (Prüfung `schema_version` im Manifest; bei Abweichung Import ablehnen).
- Neues kleines Setup `docker-compose.offline.yml` (Postgres + App + TLS-Proxy, gleiches Image, `APP_MODE=offline`, **eigener** `ENCRYPTION_KEY` nur wenn reduzierter Snapshot, sonst der Prod-Key) und ein Import-Befehl `npm run offline:import -- <datei>` bzw. Importseite.
- Import: Passphrase, Signatur und Schema prüfen → leere DB befüllen → `instance_authority.role = 'offline_primary'`, `snapshot_id`/`taken_at` setzen. Offline-Instanz weigert den Import, wenn sie bereits `offline_primary` ist (keine Vermischung zweier Snapshots).
- Sichtbare Kennzeichnung: roter Dauer-Banner „OFFLINE-VERSION – Stand vom <Zeit>", andere Farbe/Favicon; **Stripe-, SMTP-, Webhook- und Reminder-Jobs sind in `APP_MODE=offline` deaktiviert** (sonst gehen doppelte Mails/Erinnerungen raus, vgl. `runDueAutoDeletions` und Con-Zahler-Automation in `backend/server.js`). Ausgehende Mails werden in eine Outbox gelegt und erst nach der Rückgabe online versendet.
- Die Hardware-Checkliste (WLAN-Router ohne Internet, feste IP/Hostname, Ersatzlaptop mit identischer Kopie, USV/Powerbank) kommt in `docs/betrieb-offline.md`.

### 4. Rückgabe nach dem Con (oder zwischendurch für Teilstände)
- Offline: Seite „Rückgabepaket erzeugen" → exportiert **nur** die Offline-Domäne (siehe Eigentümer-Liste) als signierte, verschlüsselte Datei; Offline-Instanz geht auf `retired` (nur noch lesend) und zeigt „Bitte Paket sichern". Zwischenexport möglich (`generation` im Paket), z. B. nachts als Backup auf USB-Stick — sperrt Offline nicht.
- Online: Admin importiert Paket. Prüfungen: Signatur, `snapshot_id` = aktuelle Delegation, Online `role = delegated`, Schema-Version passt. Dann in **einer Transaktion**: Check-in-Felder je Registrierung übernehmen (Regel: später gesetzter Status gewinnt nicht, sondern der Offline-Stand, da Online gesperrt war), Tavern-Konten **mit Saldo prüfen**: Summe der Transaktionen == `balance_cents`, sonst Import abbrechen mit Bericht. Neue Konten/Transaktionen per UUID `INSERT … ON CONFLICT DO NOTHING` (idempotent, Paket darf mehrfach eingespielt werden; relevant für Zwischenexporte).
- Ergebnisbericht (Anzahl Check-ins, Buchungen, Saldosumme, Auffälligkeiten), Eintrag in `snapshot_log` und Audit-Log, dann `role = 'primary'`, `generation + 1`, Banner weg.

### 5. Schutz vor „falscher Datenbank"
- Jede Instanz prüft beim Start `instance_authority`: `delegated` + `APP_MODE=online` → Schreib-Guard aktiv; `retired`/`offline_primary` + `APP_MODE=online` → Start-Warnung (jemand hat eine Offline-DB als Prod gestartet).
- Rückgabepakete einer **älteren** Delegation (`generation` kleiner) oder fremden `instance_id` werden hart abgelehnt.
- Mehrere Admins: Erzeugen/Aufheben/Rückgabe nur nach Bestätigung; alles im Audit-Log (`backend/audit`, neue Aktionstypen `offline_snapshot`, `offline_return`, `offline_force_release`).

## Offene Entscheidungen (bitte klären)
1. **Umfang des Snapshots:** Voll-Dump (einfach, aber alle Gesundheits-/Kontodaten auf dem Laptop) **oder** reduziert (Namen, Ticket/QR-Kennung, Gruppe/Rolle, Status, Zahlungsstatus, Charakternamen, Taverne; ohne Adressen/Gesundheit/Passwort-Hashes). *Empfehlung: reduziert, mit Gast-Admin-Login nur für Check-in-/Taverne-Helfer.* Voll-Dump bleibt als Option.
2. **Je Event oder global delegieren?** Empfehlung: **je Event** (Spalte `event_id`), weil Check-in und Taverne ohnehin Event-bezogen sind; andere Events bleiben online benutzbar.
3. **Logins offline:** Helfer müssen sich offline anmelden → Sessions/Passwort-Hashes der berechtigten Rollen gehören in den Snapshot (bei reduziertem Snapshot nur diese Konten). Alternativ eigene Offline-Helfer-PINs je Snapshot.
4. **Online während des Cons parallel nutzbar?** Empfehlung ja (Anmeldungen/Zahlungen laufen), Check-in/Taverne gesperrt.
5. **Hardware:** Wer stellt Laptop, WLAN-Router und Zertifikat? Ersatzgerät?

## Umsetzungsschritte (Reihenfolge, je Schritt mit Tests, rot zuerst)
1. **Migration + Repository** `backend/instanceAuthority/` (Zustand lesen/setzen, Übergänge validieren) + Unit-Tests der Zustandsmaschine (`primary→delegated→primary`, verbotene Übergänge, Force-Release).
2. **Schreib-Guard** (Middleware) für Check-in-/Taverne-Routen + Integrationstests (423 im Zustand `delegated`, Lesen ok, andere Routen unberührt, Nummernvergabe-Regel).
3. **Export/Import-Format** `backend/offlinePackage/`: Manifest, HMAC, Passphrase-Verschlüsselung (Node `crypto`, scrypt + AES-GCM), Schema-Versionsprüfung; Round-Trip-Test Snapshot → leere DB → Rückgabepaket → Online-Import.
4. **Rückgabe-Merge** mit Saldoprüfung, Idempotenz, Konflikttests (selbes Konto offline und online geändert, doppelter Import, falsche Snapshot-ID, älteres Paket).
5. **`APP_MODE=offline`:** Jobs/Webhooks/Mails deaktivieren, Outbox, Banner, Startprüfung. Test: im Offline-Modus werden keine ausgehenden Verbindungen aufgebaut.
6. **Admin-UI** (Erzeugen, Status, Aufheben, Rückgabe-Import) + Offline-Seiten (Import, Rückgabepaket).
7. **Betriebspaket:** `docker-compose.offline.yml`, TLS-Proxy, `docs/betrieb-offline.md` (Checkliste, Probelauf), Ergänzung `CLAUDE.md` (Compose-Hinweis: es gibt eine dritte Compose-Datei, immer explizit mit `-f` wählen).
8. **Generalprobe:** kompletter Ablauf mit Testevent, mehreren Handys im Router ohne Internet, absichtlich mit Netzabbruch und Neustart des Laptops; Zeitmessung Import/Rückgabe. Zusammen mit P1 (Echtgerätetest) und P5 (Backup: Offline-Instanz ist selbst ein Backup-Ziel, Zwischenexport auf USB).

## Abhängigkeiten zu den anderen Plänen
- **P5 vor P7:** Vor der ersten echten Delegation braucht Online ein getestetes Backup.
- **P1** deckt die Handy-/Kamera-Seite ab; P7 ergänzt dort den HTTPS-LAN-Test.
- **P6 (CI)** soll den Round-Trip-Test (Schritt 3/4) mitlaufen lassen.

## Risiken
- Vergessene Rückgabe → Online bleibt gesperrt (Banner, Mail an Admins nach X Stunden; `Delegation aufheben` als Notweg).
- Gleichzeitiger Start zweier Offline-Instanzen aus demselben Snapshot → Pakete würden sich widersprechen; Schutz: erster akzeptierter Rückgabe-Import entwertet den Snapshot, zweites Paket wird mit Hinweis abgelehnt (manuelles Zusammenführen als Notfall).
- Uhrzeit auf dem Laptop falsch → `created_at` der Offline-Buchungen unplausibel; beim Import Uhrenabweichung gegen Manifest prüfen und warnen.

## Aufwand (Schätzung)
Ca. 6–9 Entwicklertage plus 1 Tag Generalprobe; größter Block ist der saubere Rückgabe-Merge mit Saldoprüfung und der reduzierte Snapshot. Versionswirkung: `feat:` → MINOR-Bump am Tag des ersten Feature-Commits (CLAUDE.md-Schema).
