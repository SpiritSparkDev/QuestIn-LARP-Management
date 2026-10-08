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

## Datenmodell (neue Migration, nächste freie Nummer, aktuell `098_instance_authority.sql`)
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

## Ergänzung: Modus-Schalter oben rechts, Zeitstempel, Konfliktmenü

### Bedienkonzept: ein Schalter, zwei Zustände
Oben rechts (Seitenkopf, außerdem in der Vollbild-Leiste `standalone-bar` von `/checkin` und `/taverne`) steht ein **Modus-Chip**:
- `● Online · live` (grün) — normale Datenbank.
- `● Offline · Stand 07.10. 14:32` (rot/orange) — Offline-Version; der Zeitstempel ist `snapshot_taken_at` und bleibt dauerhaft sichtbar; Tooltip: Snapshot-ID (gekürzt), Erzeuger, Anzahl offline erfasster Vorgänge seit dem Stand.
- `● Offline-Rückgabe offen` (gelb) — Online ist an eine Offline-Version delegiert (siehe oben), mit Zeitstempel „delegiert seit …".
- `● Konflikte (3)` (rot, pulsierend) — Rückgabe hat Konflikte erzeugt; Klick öffnet das Konfliktmenü.
Technisch erweitert das `account`-Objekt (`/account`) um `instance: { role, snapshotTakenAt, delegatedSince, openConflicts }`; `frontend/js/nav.js` rendert den Chip dort, wo schon `showTestModeBanner` und `initStandaloneMode` ansetzen. Kein neues Framework nötig; Farbe zusätzlich über Text/Icon, nicht nur über Farbe (Barrierefreiheit).

**Wichtig:** Der Schalter ist ein *geführter Wechsel*, kein sofortiges Umlegen. Ein Browser spricht immer mit genau einem Server; „umschalten" heißt, die schreibberechtigte Datenbank zu übergeben. Daher je Klick ein Dialog, der die Folgen nennt:
1. **Online → Offline gehen** (nur auf der Online-Instanz, Admin-Recht): Dialog „Check-in und Taverne werden hier gesperrt, bis die Offline-Version zurückgegeben wird." Passphrase vergeben → Paket erzeugen und herunterladen (Ablauf Punkt 1 oben). Danach zeigt der Dialog den Weg zur Offline-Instanz (Link/QR auf `https://con.local`).
2. **Offline → Online gehen** (auf der Offline-Instanz): Dialog prüft, ob der Online-Server erreichbar ist (`GET <online-url>/health`).
   - **Erreichbar:** direkter Abgleich über die Leitung: Rückgabepaket wird automatisch zum Online-Server geschickt (authentifiziert mit einem einmaligen Rückgabe-Token, das beim Erzeugen des Pakets im Manifest steht), Merge läuft, Ergebnis wird angezeigt.
   - **Nicht erreichbar:** Datei-Export (USB/Mail), Import später online.
   - Beide Wege enden gleich: Konfliktfrei → `retired` bzw. neuer Zwischenstand (siehe unten) und Chip wechselt auf Online; mit Konflikten → Chip „Konflikte (n)", Rückgabe bleibt **offen**.
3. **Mehrfaches Hin- und Herwechseln** (z. B. Mittagspause mit Netz): Statt Endgültigkeit gibt es den **Zwischenabgleich**: Rückgabe + sofort neuer Snapshot mit höherer `generation`, die Offline-Instanz bleibt schreibberechtigt und arbeitet weiter. Online bleibt delegiert. So muss nicht bei jedem Netz-Moment alles neu eingerichtet werden.
4. Nie ohne Rückfrage: kein Wechsel während laufender Buchung/Scan (Button zeigt „Vorgang läuft"), und der Wechsel verlangt dieselbe Berechtigung wie das Erzeugen des Pakets.

### Konfliktmenü („Datenabgleich")
Neuer Menüpunkt unter Admin/Check-in, sichtbar nur mit Admin-Recht, per Chip erreichbar. Er arbeitet mit einer Tabelle `sync_conflicts` (neue Migration, zusammen mit `098`): `id`, `snapshot_id`, `generation`, `type`, `entity` (z. B. registration/tavern_account), `entity_id`, `offline_value jsonb`, `online_value jsonb`, `status` (`open`/`resolved`), `resolution` (`offline`/`online`/`merged`/`ignored`), `resolved_by`, `resolved_at`, `note`.

**Wann entsteht ein Konflikt** (alles andere wird automatisch und idempotent übernommen):
| Typ | Beispiel | Vorgeschlagene Standardlösung |
|---|---|---|
| `registration_changed_online` | Offline eingecheckt, online inzwischen storniert/abgesagt | Check-in übernehmen und Status „Angemeldet" manuell klären (Admin entscheidet) |
| `account_deleted_online` | Konto online gelöscht/DSGVO, offline noch Taverne-Buchungen | Buchungen als anonymisiertes Konto behalten (Beträge müssen erhalten bleiben) |
| `tavern_number_collision` | gleiche Konto-Nummer offline und online vergeben | Offline-Konto auf nächste freie Nummer umnummerieren, Konflikt zur Bestätigung zeigen |
| `balance_mismatch` | Summe der Transaktionen ≠ `balance_cents` | **Blockiert** Rückgabe-Merge dieses Kontos; Admin sieht Buchungsliste und entscheidet |
| `duplicate_walkin` | derselbe Gast offline zweimal als Walk-in angelegt | Zusammenführen anbieten (Salden addieren) |
| `forced_release` | Delegation wurde aufgehoben, Offline brachte trotzdem Daten mit | Paket nicht automatisch übernehmen, manuelle Einzelprüfung |
| `schema_mismatch` / `clock_skew` | andere App-Version, Uhr > 5 min abweichend | Warnung/Abbruch, kein Teilimport |
| `unknown_entity` | Paket verweist auf Datensatz, den es online nicht gibt | Datensatz einzeln anzeigen, übernehmen oder verwerfen |

**Oberfläche:**
- Liste mit Filter (offen/gelöst, Typ), je Zeile **Offline-Stand | Online-Stand** nebeneinander, Felder die abweichen hervorgehoben, Zeitstempel beider Seiten.
- Aktionen je Zeile: *Offline übernehmen*, *Online behalten*, *Zusammenführen* (nur wo definiert, z. B. Salden), *Später* (bleibt offen), Notizfeld. Sammelaktion „alle Vorschläge übernehmen" nur für Typen mit eindeutiger Standardlösung, mit Vorschau.
- **Verhalten bei offenen Konflikten:** Datensätze ohne Konflikt sind bereits übernommen; betroffene Datensätze bleiben im Zustand „vor der Rückgabe" und sind markiert; Online bleibt `delegated`, bis alle Konflikte gelöst sind; erst dann `primary` und `generation + 1`. Ein „Notfall-Freigabe"-Knopf (doppelt bestätigt, protokolliert) kann Online trotz offener Konflikte freigeben, damit der Betrieb nie am Menü hängt.
- Alles protokolliert (`backend/audit`: `sync_conflict_resolved`, mit Vorher/Nachher), Export der Konfliktliste als CSV für die Nachbereitung.
- Offline-Instanz zeigt dieselbe Liste **lesend** an (Konflikte entstehen erst beim Abgleich, gelöst wird online), plus Hinweis „Online lösen".

### Auswirkung auf die Umsetzungsschritte
- Schritt 1 (Migration): zusätzlich `sync_conflicts`.
- Schritt 4 (Rückgabe-Merge): liefert statt Abbruch eine Konfliktliste, übernimmt konfliktfreie Teile idempotent, Zwischenabgleich (`generation`) eingebaut, direkter Online-Abgleich per Token.
- Schritt 6 (Admin-UI): Modus-Chip in `frontend/js/nav.js`, Dialoge für beide Wechselrichtungen, Seite `frontend/admin/sync.html` (Konfliktmenü).
- Zusätzliche Tests: Zustandsanzeige im `/account`-Objekt, jeder Konflikttyp einmal (inkl. Auflösung je Option), Zwischenabgleich zweimal hintereinander, direkter Abgleich ohne und mit erreichbarem Server, Rückgabe-Token einmalig verwendbar.
- Aufwand steigt um ca. 2–3 Tage (Konfliktmenü ~1,5, Chip/Dialoge/Direktabgleich ~1).

## Offene Entscheidungen (bitte klären)
1. **Umfang des Snapshots:** Voll-Dump (einfach, aber alle Gesundheits-/Kontodaten auf dem Laptop) **oder** reduziert (Namen, Ticket/QR-Kennung, Gruppe/Rolle, Status, Zahlungsstatus, Charakternamen, Taverne; ohne Adressen/Gesundheit/Passwort-Hashes). *Empfehlung: reduziert, mit Gast-Admin-Login nur für Check-in-/Taverne-Helfer.* Voll-Dump bleibt als Option.
2. **Je Event oder global delegieren?** Empfehlung: **je Event** (Spalte `event_id`), weil Check-in und Taverne ohnehin Event-bezogen sind; andere Events bleiben online benutzbar.
3. **Logins offline:** Helfer müssen sich offline anmelden → Sessions/Passwort-Hashes der berechtigten Rollen gehören in den Snapshot (bei reduziertem Snapshot nur diese Konten). Alternativ eigene Offline-Helfer-PINs je Snapshot.
4. **Online während des Cons parallel nutzbar?** Empfehlung ja (Anmeldungen/Zahlungen laufen), Check-in/Taverne gesperrt.
5. **Hardware:** Wer stellt Laptop, WLAN-Router und Zertifikat? Ersatzgerät?
6. **Direkter Online-Abgleich** per Netzwerk (Offline-Laptop schickt die Rückgabe selbst, sobald Internet da ist) zusätzlich zum Datei-Weg? Empfehlung ja, mit einmaligem Rückgabe-Token.
7. **Wer darf den Schalter benutzen?** Empfehlung: nur Admin; Check-in-Helfer sehen den Chip nur lesend.

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
Ca. 8–12 Entwicklertage (inkl. Modus-Schalter und Konfliktmenü) plus 1 Tag Generalprobe; größter Block ist der saubere Rückgabe-Merge mit Saldoprüfung und der reduzierte Snapshot. Versionswirkung: `feat:` → MINOR-Bump am Tag des ersten Feature-Commits (CLAUDE.md-Schema).
