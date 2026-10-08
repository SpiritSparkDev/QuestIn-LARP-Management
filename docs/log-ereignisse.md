# Protokoll (Audit-Log) und Backup

Stand: 2026-10-08. Das Protokoll liegt in der Tabelle `audit_log` und ist im Admin-Menü unter **Protokoll** einsehbar (nach Kategorien filterbar). Geschrieben wird über `logAudit()` aus `backend/audit/repository.js`; ein Fehler dort bricht die eigentliche Aktion nie ab.

## Grundsatz: nur Wichtiges
Protokolliert werden Ereignisse, die jemand später nachvollziehen will (Anlegen, Löschen, Geld, Rechte, Versand, Export). **Nicht** protokolliert werden Profil- und Feldänderungen, Textbearbeitungen, Dateiuploads, Logins. Im Protokoll stehen keine Feldinhalte, nur Namen/Beträge/Art des Ereignisses.

## Aktuelle Ereignisse
| Aktion | Wann |
|---|---|
| `user.registered` | Neues Konto registriert |
| `role.changed` | Rolle eines Kontos geändert (Mitglieder-Verwaltung) |
| `character.created` / `character.deleted` | Charakter angelegt / gelöscht (Name, ggf. „trotz Anmeldung") |
| `character.staff_field_changed` | Staff-Feld eines Charakters geändert |
| `registration.created` | Anmeldung zu einem Event (auch Warteliste, auch durch Orga/Verwalter) |
| `registration.cancelled` | Abmeldung durch die Person selbst oder Storno durch Orga |
| `checkin.confirm` | Angaben beim Check-in bestätigt/korrigiert |
| `payment.received` | Zahlung eingegangen (Stripe, manuell als bezahlt markiert, Tavernen-Online-Aufladung) |
| `payment.refunded` | Zahlung erstattet |
| `group.created` | Rolle (Gruppe) im Admin angelegt |
| `group_tree.founded` | Gruppe gegründet (Gruppenname erstmals gesetzt) |
| `group_tree.join_code_redeemed` | Gruppe per Code beigetreten |
| `link.sent` | Zugangs-/Einladungslink versendet oder erzeugt (Bestätigung, Passwort, Einladung, erneut, Gast-Umwandlung) |
| `members.export`, `checkin.export`, `tavern.export` | CSV-Exporte |
| `backup.created` | Backup heruntergeladen |
| weitere | `offline_*`, `sync_conflict_resolved`, `privacy.deletion`, `managed_person.*`, `event.mailing` |

## Vorschläge für weitere Ereignisse (noch nicht eingebaut)
- Event angelegt / beendet / wieder geöffnet
- Wartelisten-Beförderung (wer ist nachgerückt)
- Konto deaktiviert / reaktiviert / gelöscht durch Orga
- Änderungen an Einstellungen mit Wirkung nach außen (SMTP, Zahlungs-Zugang, Speicher-Backend) – ohne Werte
- Gesperrte Logins (nur Sperre nach zu vielen Fehlversuchen, nicht jeder Fehlversuch)
- Betrag/Rabatt einer Anmeldung manuell geändert (Geld!)
- Check-in rückgängig / Status per Override geändert

## Zahlungen: Merker für PayPal / Stripe
Jede Zahlungsquelle muss nach dem Verbuchen `logPaymentReceived({ userId, eventId, provider, method, amountCents, reference, kind })` aus `backend/payments/repository.js` aufrufen (nur wenn tatsächlich neu gebucht wurde, nicht bei Webhook-Wiederholungen). Heute sind angebunden: Stripe-Webhook (Tickets und Tavernen-Aufladung) und „als bezahlt markieren" (`provider: 'manual'`). **Wird PayPal ergänzt oder der Stripe-Ablauf angefasst: dort `provider: 'paypal'` bzw. den neuen Pfad ebenfalls anbinden**, sonst fehlen Zahlungen im Protokoll. Erstattungen laufen über `refundPayment()` und werden dort protokolliert.

## Backup (Admin → Backup)
- **Erstellen:** `POST /backup/export` (nur Admin). Umfang `participants` (Konten, Charaktere, Anmeldungen, Zahlungen, Datei-Verweise), `events` (Events, Unterkünfte, Mailings, Feldschemata, dazu **Metadaten** je Event mit Anmeldezahlen je Status) oder `all`.
- **Ziele (mehrere gleichzeitig):** `download` (Antwort, Ergebnisse der anderen Ziele im Header `X-Backup-Results`), `local` (Ordner `BACKUP_LOCAL_DIR`, Standard `./backups`; im Docker-Betrieb ein Volume einhängen), `s3` (S3-kompatibel), `sftp`. Zugangsdaten für S3/SFTP liegen verschlüsselt in `backup_settings` (Seite „Ziele einrichten", mit Verbindungstest). Ein fehlschlagendes Ziel stoppt die anderen nicht; das Ergebnis je Ziel steht in der Antwort und im Protokoll (`backup.created`).
- **Datei:** `.qbak`, mit frei gewähltem Passwort (mind. 8 Zeichen) verschlüsselt und signiert; Format wie die Offline-Pakete (`backend/offlinePackage/container.js`, `open(buffer, passphrase)`). Nicht enthalten: Passwort-Hashes und alle `*token*`-Spalten, die hochgeladenen Dateien selbst. Verschlüsselte Personenfelder bleiben verschlüsselt und brauchen den `ENCRYPTION_KEY` des Servers.
- **Einspielen:** `POST /backup/inspect` (Datei prüfen, ändert nichts) und `POST /backup/restore` (`confirm: true`, `parts`). Die Daten werden **zusammengeführt** (Upsert je Primärschlüssel, Reihenfolge nach Abhängigkeiten, in einer Transaktion: bei Fehler bleibt alles unverändert). Nichts wird gelöscht; fehlende Spalten (Passwort-Hash, Tokens) behalten ihren Wert. Voraussetzung: gleicher Datenbankstand (`schemaVersion`). Neu angelegte Konten haben kein Passwort und nutzen „Passwort vergessen". Rollen werden über den Rollen-Schlüssel (`group_key`) zugeordnet. Protokoll: `backup.restored`.
- Die vollständige Datenbank-Sicherung samt Restore läuft weiterhin über den Backup-Dienst (`docs/betrieb-backup.md`).
- **Datenschutz:** Abschnitt „Datensicherung (Backups)" in `frontend/datenschutz.html`. Wird ein Ziel (z. B. ein neuer S3-/SFTP-Anbieter) geändert, die Empfängerliste dort anpassen und mit dem Anbieter einen AV-Vertrag schließen.
