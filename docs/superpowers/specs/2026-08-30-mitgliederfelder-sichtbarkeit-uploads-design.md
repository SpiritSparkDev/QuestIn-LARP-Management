# Mitgliederfelder, Sichtbarkeit & Datei-Uploads — Design

**Status:** Approved by user 2026-08-30, ready for plan decomposition.

## Kontext

Nutzer-Feedback zu drei Seiten (`admin/members.html`, `admin/groups.html`, `characters.html`) wurde in fünf unabhängige, aufeinander aufbauende Teile zerlegt. Während der Klärung stellte sich heraus, dass „Einladung verschicken: Bestätigung/Fehler rückmelden" eigentlich eine fehlende SMTP-Konfigurationsmöglichkeit ist (die App läuft mangels `SMTP_HOST` im No-Op-Mailversand-Modus, meldet das aber nicht), und dass „Feldern einen Link-Zusatz erlauben" zusammen mit einer gewünschten Sichtbarkeits-Checkbox pro Feld ein neues, generelles öffentlich/privat-Modell für Charakter-Schema-Felder ergibt — inklusive einer bisher nicht existierenden Seite, um fremde Charaktere überhaupt zu durchsuchen.

**Reihenfolge (jeder Teil ein eigener Plan):** 1 → 2 → 3 → 4 → 5. Teil 5 baut auf Teil 4s Sichtbarkeitsmodell auf, sonst sind alle Teile unabhängig voneinander.

---

## Teil 1: UI-Kleinigkeiten

### 1.1 Geburtsdatum-Autoformatierung
`frontend/account.html:25` und die entsprechenden Felder in `admin/members.html` sind bereits reine Textfelder (`type="text"`, Placeholder `TT.MM.JJJJ`) — kein Kalender-Wähler vorhanden, das ist schon erfüllt. Fehlt: automatisches Einfügen der Punkte beim Tippen.

Neue Funktion `attachBirthdateFormatter(inputEl)` in `frontend/js/formFields.js`: ein `input`-Event-Listener, der bei jeder Eingabe alle Nicht-Ziffern entfernt, auf maximal 8 Ziffern kappt und nach der 2. und 4. Ziffer einen Punkt einfügt (`29011991` → `29.01.1991`, wächst live beim Tippen). Angewendet auf jedes Geburtsdatum-Textfeld (Account-Seite, Mitglieder-Detail, Einladungs-Formular).

### 1.2 Gruppe bearbeiten als Pop-up
`admin/groups.html`s Formular (aktuell dauerhaft sichtbar unter der Tabelle) wird in ein natives `<dialog>`-Element verschoben, geöffnet via `.showModal()` bei „Neue Gruppe anlegen" oder „Bearbeiten", geschlossen via `.close()` bei Speichern/Abbrechen. Kein neues Package nötig — `<dialog>` ist eine native Plattform-Funktion, matcht das Projekt-Prinzip „native vor Bibliothek".

### 1.3 Feldbezeichnungen unter das Feld
`frontend/js/formFields.js`s `renderField()` vertauscht in jedem Zweig die Reihenfolge von `<label>` und Eingabeelement (Input zuerst, Label danach) plus eine CSS-Regel, die das Label unter dem Feld positioniert (die bestehenden Themes `chronicle-crest.css`/`everest-registry.css` müssen ggf. eine `.field-label-below`-Regel bekommen, da Label-Reihenfolge im DOM UND CSS-Display zusammenspielen).

---

## Teil 2: Mitgliederdaten-Felder überarbeiten

### 2.1 Name → Vorname/Nachname/Rufname
`users.name` und `invitations.name` sind aktuell einzelne, unverschlüsselte `text not null`-Spalten (bewusst unverschlüsselt, da an vielen Stellen für Anzeige/Sortierung gebraucht — `ORDER BY users.name`, Charakterbesitzer-Anzeige, Mitgliederliste, Nav). Diese Entscheidung wird beibehalten: die neuen Felder bleiben ebenfalls unverschlüsselt.

Migration `015_split_name_fields.sql`: fügt `first_name text`, `last_name text`, `nickname text` zu `users` und `invitations` hinzu. Backfill aus dem bestehenden `name`-Wert (Split am ersten Leerzeichen: alles vor dem ersten Space → `first_name`, Rest → `last_name`, leer falls kein Space vorhanden). Danach `first_name`/`last_name` `NOT NULL`, `name`-Spalte wird gelöscht.

Neuer Helper `displayName({firstName, lastName, nickname})` (z.B. in `backend/accountFields.js` oder einem neuen `backend/displayName.js`) — gibt `nickname` zurück falls gesetzt, sonst `` `${firstName} ${lastName}` ``. Ersetzt jede bisherige direkte Verwendung von `.name` zur Anzeige (Mitgliederliste, Charakterbesitzer, Nav, E-Mail-Texte). Formulare (Account, Invite, Mitglieder-Detail) bekommen drei Felder: Vorname*, Nachname*, Rufname (optional).

### 2.2 Notfallkontakt → Name, Vorname, Telefonnummer
`emergency_contact_enc` (eine verschlüsselte Spalte) wird zu drei verschlüsselten Spalten: `emergency_contact_last_name_enc`, `emergency_contact_first_name_enc`, `emergency_contact_phone_enc` — gleiches Verschlüsselungsmuster wie jedes bestehende Feld (`encryptField`/`decryptField` aus `backend/crypto/fieldCrypto.js`). Migration fügt die drei neuen Spalten hinzu und löscht die alte; kein Backfill möglich (Freitext lässt sich nicht zuverlässig automatisch in drei Teile zerlegen) — bestehende Notfallkontakt-Daten gehen beim Umstieg verloren, das wird im Plan explizit als bewusste, dem Nutzer mitzuteilende Konsequenz vermerkt.

`ACCOUNT_FIELD_KEYS` in `backend/accountFields.js` verliert `emergencyContact`, bekommt `emergencyContactLastName`, `emergencyContactFirstName`, `emergencyContactPhone`.

### 2.3 Pronomen entfernen
Vollständige Rückabwicklung von Migration `009_pronomen_field.sql`. Betroffen (per `grep -rl pronomen`): `backend/accountFields.js`, `backend/accounts/repository.js`, `backend/auth/invite.js`, `backend/invitations/repository.js`, `backend/members/repository.js`, `backend/members/routes.js`, `frontend/account.html`, `frontend/admin/groups.html`, `frontend/admin/members.html`, `db/groupDefaults.js`. Neue Migration `016_remove_pronomen_field.sql`: `ALTER TABLE users DROP COLUMN pronomen_enc`, `ALTER TABLE invitations DROP COLUMN pronomen_enc` (falls dort vorhanden — verifizieren), plus eine `UPDATE groups SET account_fields = account_fields - 'pronomen'`-Zeile für bereits gesetzte Gruppen (gleiches „retroactive grant/revoke"-Muster wie bei `009`/`010`/`013`). `db/groupDefaults.js` verliert `'pronomen'` aus jedem `accountFields`-Array.

---

## Teil 3: SMTP-Konfiguration in der App

### 3.1 Datenmodell
Neue Tabelle `smtp_settings` (Single-Row-Pattern, wie `character_form_schema`/`nsc_profile_schema` bereits als Ein-Zeilen-Tabellen existieren — Migration `017_smtp_settings.sql`):
```sql
CREATE TABLE smtp_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  host text,
  port integer,
  username text,
  password_enc bytea,
  from_address text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```
(Das `id boolean PRIMARY KEY DEFAULT true CHECK (id)`-Muster erzwingt maximal eine Zeile, ohne eine Applikationsebene dafür zu brauchen.) Nur `password_enc` wird verschlüsselt (`encryptField`) — Host/Port/User/Absender sind nicht sensibel genug, um dem bestehenden Verschlüsselungs-Aufwand zu rechtfertigen (gleiche Abwägung wie bei `users.name`).

### 3.2 Mailer-Änderung
`backend/auth/mailer.js`s `getTransporter()` liest künftig zuerst aus `smtp_settings` (DB), fällt auf die bestehenden `process.env.SMTP_*`-Variablen zurück, falls keine Zeile existiert (hält Docker-Compose-Dev/Test-Setups ohne Migration lauffähig). Der Transporter wird nicht mehr modulweit gecacht (aktuell `let transporter` einmalig erzeugt) — stattdessen bei jedem Versand neu aus den aktuellen Einstellungen gebaut, da sich die Konfiguration jetzt zur Laufzeit über die neue Admin-Seite ändern kann (E-Mail-Versand ist kein Hot Path, der Overhead ist vernachlässigbar).

### 3.3 Neue Routen (admin-only, `requireAdminGroup`)
- `GET /admin/settings/smtp` — aktuelle Einstellungen (Passwort NICHT im Klartext zurückgeben, nur ein `hasPassword: boolean`-Flag, analog zu keinem anderen Secret-Roundtrip im Projekt).
- `PUT /admin/settings/smtp` — speichert `{host, port, username, password, fromAddress}`; `password` optional (leer lassen = bestehendes Passwort behalten, `COALESCE`-Pattern wie bei jedem anderen Feld-Update).
- `POST /admin/settings/smtp/test` — nimmt `{host, port, username, password, fromAddress, to}` direkt aus dem (ggf. ungespeicherten) Formular entgegen, baut einen Transporter ad-hoc und versendet eine Test-Mail an `to` — unabhängig von den gespeicherten Einstellungen, damit ein Tippfehler vor dem Speichern auffällt.

### 3.4 Neue Seite `frontend/admin/settings.html`
Formular für Host/Port/User/Passwort/Absender + „Test-Mail senden"-Button (fragt nach Ziel-E-Mail, zeigt Erfolg/Fehler). Neuer Menü-Schlüssel `'einstellungen'` in `visible_menus` (nur `admin` bekommt ihn per Default in `db/groupDefaults.js`, wie jedes andere Menü datengetrieben, keine neue Sonderprüfung nötig).

### 3.5 Sichtbares Fehlschlagen beim Einladen
`backend/auth/invite.js`s `sendInvitationEmail`-Aufruf ist aktuell in einem `try/catch` mit nur `logger.error(...)` — der Fehler erreicht die Admin-UI nie. Die Einladung selbst (DB-Zeile) soll weiterhin erstellt werden, auch wenn der Mailversand fehlschlägt (Admin kann jederzeit über den bestehenden „Erneut senden"-Button nachholen) — aber die Response bekommt ein `emailSent: boolean`-Feld, und `admin/members.html`s Erfolgsmeldung wird bei `emailSent: false` zu einer auffälligen Warnung („Einladung erstellt, aber E-Mail-Versand fehlgeschlagen: <Fehlermeldung>. Bitte SMTP-Einstellungen prüfen oder erneut senden.") statt der stillen Erfolgsmeldung. `register.js`/`passwordReset.js` bleiben bewusst unverändert (Fire-and-forget mit Logging) — dort gibt es keinen Admin, der eine Warnung sehen und handeln könnte, und ein Blockieren der Registrierung auf E-Mail-Erfolg wäre schlechtere UX für Endnutzer.

---

## Teil 4: Charakter-Feld-Sichtbarkeit + Link-Feldtyp

### 4.1 Neuer Feldtyp `'link'`
`backend/events/schemaValidation.js`: `link`-Felder werden wie `text` behandelt, zusätzlich validiert als `http://`/`https://`-URL (einfacher Prefix-Check, kein volles URL-Parsing nötig). `frontend/js/formFields.js`s `renderField()`: neuer Zweig für `type === 'link'` — Eingabe als `<input type="url">`, Anzeige (read-only Kontext, siehe 4.4) als `<a href="...">`.

### 4.2 Sichtbarkeits-Flag pro Feld
Jedes Feld-Objekt im `character_form_schema` (JSONB-Array) bekommt ein optionales `public: boolean` (Default/Fehlen = privat). Kein Schema-Zwang in `validateSchemaShape` nötig über „falls vorhanden, muss es ein Boolean sein" hinaus. `admin/events.html`s Schema-Builder (pro Feld-Zeile) bekommt eine neue Checkbox „Öffentlich sichtbar".

### 4.3 Sichtbarkeitsregeln
„Privat" = Besitzer des Charakters + jede Gruppe mit `canOverrideCheckinStatus: true` (wiederverwendet die bestehende, bereits datengetriebene Berechtigung, die schon exakt die gewünschte Admin/Orga/SL-Kombination abbildet — keine neue Gruppen-Spalte nötig). „Öffentlich" = zusätzlich jeder authentifizierte Nutzer.

Neuer Helper `filterCharacterFields(character, schema, viewer)` in `backend/characters/`: gibt bei `viewer.isOwner || viewer.canOverrideCheckinStatus` das volle `data`-Objekt zurück, sonst nur die Schlüssel, deren Schema-Feld `public: true` hat.

### 4.4 Neue Route + Seite zum Durchsuchen
`GET /events/:eventId/characters/public` — listet alle Charaktere des Events (fremde UND eigene) mit jeweils nur den öffentlichen Feldern (eigene Charaktere zeigt der Nutzer stattdessen vollständig über die bestehende `GET /characters`-Route mit eigener UI). Neue Seite `frontend/characters-browse.html`: Event-Auswahl, dann eine Liste/Kartenübersicht aller Charaktere mit Name + öffentlichen Feldern. Neuer Nav-Eintrag im bestehenden `charaktere`-Menü (kein neuer Menü-Schlüssel nötig, es ist eine Unteransicht der bestehenden Charaktere-Sektion).

---

## Teil 5: Datei-Upload für Charaktere

*(Baut auf Teil 4 auf: gleiches öffentlich/privat-Modell pro Datei, gleicher `filterCharacterFields`-artiger Sichtbarkeits-Helper.)*

### 5.1 Datenmodell
Migration `018_character_files.sql`:
```sql
CREATE TABLE character_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('image', 'document')),
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  is_public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX character_files_character_id_idx ON character_files (character_id);
```
Der physische Dateiname auf der Platte ist immer `${id}` (die UUID der Zeile, ohne Erweiterung) — der `original_filename` dient nur der Anzeige/dem Download-Namen, wird NIE für den Dateisystem-Pfad verwendet (schließt Path Traversal strukturell aus, gleiches Prinzip wie `backend/staticFiles.js`s bestehende `path.resolve`+`startsWith`-Absicherung, hier sogar stärker: kein clientgesteuerter Pfad-Teil überhaupt).

Erweiterung von `smtp_settings`-artigen Einstellungen um eine zweite Single-Row-Tabelle `upload_settings` (oder eine Spalte in einer generischeren `app_settings`, falls Teil 3 das schon so anlegt — wird beim Schreiben von Teil 3s Plan final entschieden) mit `quota_mb_per_character integer NOT NULL DEFAULT 100`, admin-editierbar auf derselben `admin/settings.html`-Seite.

### 5.2 Speicherung
Lokales Dateisystem unter einem neuen, konfigurierbaren Verzeichnis (`process.env.UPLOADS_DIR`, Default `./uploads`), als eigenes Docker-Volume gemountet (`uploads-data:/app/uploads` in `docker-compose.yml`, analog zu `db-data`). Kein neues npm-Package für Objektspeicher nötig (Lokales-Volume-Entscheidung aus der Klärung).

### 5.3 Upload-Transport: Base64-in-JSON statt Multipart
Der Server hat aktuell keinen Multipart/form-data-Parser, und einen selbst zu schreiben ist eine nicht-triviale Sicherheitsfläche (Boundary-Parsing, Header-Injection) — würde entweder eine neue Abhängigkeit oder erheblichen Custom-Code bedeuten. Stattdessen: Dateien werden als Base64-codierter String in einem normalen JSON-Body übertragen (`FileReader.readAsDataURL()` im Frontend, `Buffer.from(base64, 'base64')` im Backend) — nutzt die komplette bestehende `readJsonBody`/Auth/Fehler-Infrastruktur unverändert mit. Kosten: ~33% Übertragungs-Overhead durch Base64, für die hier relevanten Dateigrößen (Charakterbilder, PDF-Dokumente, siehe Limit unten) vernachlässigbar.

`backend/httpBody.js`s `readJsonBody(req)` bekommt einen optionalen zweiten Parameter `maxBytes = MAX_BODY_BYTES` (Default bleibt 1.000.000 für alle bestehenden Aufrufer unverändert) — der Upload-Route wird mit einem höheren Limit aufgerufen (siehe 5.4).

### 5.4 Upload-Route & Validierung
`POST /characters/:id/files` — Body: `{ kind: 'image'|'document', filename: string, mimeType: string, dataBase64: string, isPublic: boolean, gdprConsent: true }`. Nur Besitzer oder `canOverrideCheckinStatus`-Gruppen dürfen hochladen (gleiche Regel wie Sichtbarkeit). Validierung:
- `gdprConsent !== true` → 400 (Checkbox im Frontend zwingend, siehe 5.6).
- `mimeType` gegen eine feste Allowlist geprüft (`image/jpeg`, `image/png`, `image/webp` für `kind: 'image'`; `application/pdf` für `kind: 'document'`) — alles andere 400.
- Einzeldatei-Limit 20MB (nach Base64-Dekodierung geprüft, `readJsonBody`s `maxBytes` entsprechend auf ca. 28MB gesetzt, um den Base64-Overhead abzudecken).
- Kontingent-Prüfung: `SUM(size_bytes) FROM character_files WHERE character_id = $1`, plus neue Datei, gegen `quota_mb_per_character * 1024 * 1024` — bei Überschreitung 413.

Bei Erfolg: Datei wird unter `${UPLOADS_DIR}/${newId}` geschrieben (kein Erweiterungs-Anhang nötig, `mime_type` in der DB reicht für den Content-Type beim Ausliefern), DB-Zeile erstellt.

### 5.5 Ausliefern & Löschen
`GET /characters/:characterId/files/:fileId` — prüft Sichtbarkeit wie Teil 4.3 (Besitzer/elevated immer, sonst nur falls `is_public`), liest die Datei anhand der UUID vom Datenträger, setzt `Content-Type` aus `mime_type` und `Content-Disposition: inline; filename="${original_filename}"` (escaped). 404 bei fehlendem Zugriff ODER fehlender Datei (keine Unterscheidung nach außen, verhindert Enumeration).

`DELETE /characters/:characterId/files/:fileId` — Besitzer oder elevated, entfernt DB-Zeile UND Datei vom Datenträger (in dieser Reihenfolge: DB zuerst, dann Datei — falls das Löschen der Datei fehlschlägt, bleibt wenigstens kein toter DB-Verweis auf eine tote Datei stehen für den Sichtbarkeits-Check, sondern umgekehrt höchstens eine verwaiste Datei auf der Platte, die keine Zugriffsfläche mehr hat).

### 5.6 DSGVO-Hinweis
Statischer Hinweistext oberhalb des Upload-Steuerelements auf `characters.html`: „Mit dem Hochladen bestätigst du, dass du die Rechte an dieser Datei besitzt und einverstanden bist, dass sie im Rahmen der Veranstaltung von berechtigten Personen eingesehen werden kann." Eine Checkbox „Ich habe den Hinweis gelesen" muss aktiv angehakt werden, bevor der Hochladen-Button aktiviert wird (clientseitig `disabled` bis angehakt, serverseitig zusätzlich per `gdprConsent` erzwungen — Client-Check ist reine UX, der Server-Check ist die eigentliche Durchsetzung).

---

## Selbst-Review

- **Platzhalter-Scan:** keine TBD/TODO, jede Migration hat konkretes SQL, jede Route hat konkrete Payload-Form.
- **Interne Konsistenz:** Teil 4s Sichtbarkeitsregel (Besitzer + `canOverrideCheckinStatus`-Gruppen) wird in Teil 5 identisch wiederverwendet, kein Widerspruch. Teil 3s Single-Row-Settings-Pattern wird für Teil 5s Kontingent-Einstellung wiederverwendet.
- **Scope-Check:** fünf klar geschnittene Pläne, jeder für sich lauffähig/testbar; Reihenfolge 1-5 mit einer einzigen echten Abhängigkeit (5 auf 4).
- **Mehrdeutigkeits-Check:** Notfallkontakt-Migration verliert bewusst Bestandsdaten (Freitext lässt sich nicht sicher automatisch aufteilen) — das wird im jeweiligen Plan als offene, dem Nutzer mitzuteilende Konsequenz markiert, nicht stillschweigend gelöst.
