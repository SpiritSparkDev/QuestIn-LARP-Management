# OT-Felder admin-definierbar machen (wie IT-Felder für SC/NSC) — Design Spec

## 1. Problem

IT-Felder (Charakterbögen) sind ein echtes Schema-System: `sc_character_schema`
und `nsc_profile_schema` (je eine Zeile, `schema jsonb`) enthalten eine Liste
von `{key, label, type, required, public, options}`-Objekten, admin-editierbar
über `admin/character-schema.html`, generisch gerendert/validiert über
`frontend/js/formFields.js::renderField`/`collectFieldValues` und
`backend/events/schemaValidation.js::validateSchemaShape`/
`validateCharacterData`. Ein neues Feld anzulegen ist eine Datenänderung,
keine Codeänderung.

OT-Felder (Konto-/Anmeldungsdaten) sind das Gegenteil: ein fester Satz
camelCase-Keys, hartkodiert in `backend/accountFields.js` (8 Kontofelder:
address, birthdate, phone, emergencyContactLastName/FirstName/Phone,
medicalNotes, group) und `backend/registrationFields.js` (6
anmeldungsbezogene Felder: conTage, accommodation, craftOffer, travelMethod,
dataSharingOptOut, photoOptOut), jedes an eine eigene verschlüsselte
Postgres-Spalte gebunden (`address_enc`, `con_tage_enc`, ...), namentlich
ausgeschrieben in jedem betroffenen SQL-Statement
(`accounts`/`members`/`invitations`/`registrations`-Repositories). Ein neues
Feld anzulegen erfordert heute eine Migration plus Änderungen an mindestens
6 Backend- und 4 Frontend-Dateien. `groups.account_fields` ist dabei nur eine
Sichtbarkeits-Erlaubnisliste über die feste Key-Menge, kein Typ-/Formsystem.

Der Nutzer möchte OT-Felder genauso frei vom Admin definierbar haben wie
IT-Felder.

## 2. Ziel

- Admin kann OT-Felder (Konto- und Anmeldungs-Felder) über eine Schema-UI
  frei anlegen, bearbeiten, umbenennen und löschen — analog
  `admin/character-schema.html`.
- Zwei getrennte, admin-editierbare Schemas, die die bestehende fachliche
  Trennung spiegeln:
  - **Konto-Schema** (`account_field_schema`) — gilt einmal pro Person
    (aktuell die 8 Felder aus `accountFields.js` minus `group`).
  - **Anmeldungs-Schema** (`registration_field_schema`) — gilt pro
    Event-Anmeldung (aktuell die 6 Felder aus `registrationFields.js`).
- Unterstützte Feldtypen wie bei IT-Schemas (`text`, `textarea`, `select`,
  `number`, `boolean`, `multiselect`, `link`) plus ein neuer `date`-Typ
  (natives HTML-Date-Input, ersetzt die bisherige Tipp-Auto-Formatierung für
  Geburtsdatum). Kein `public`-Flag — OT-Felder sind nie öffentlich
  sichtbar, ihre Sichtbarkeit bleibt ausschließlich über
  `groups.account_fields` gesteuert (siehe 4.4).
- Bestehende Konto-/Anmeldungsdaten (heute in 13 einzeln verschlüsselten
  Spalten) werden verlustfrei migriert.

## 3. Nicht-Ziel

- `group` (Gruppenzugehörigkeit) bleibt ein hartkodiertes, unverschlüsseltes
  Rechte-Feld außerhalb jedes Schemas — keine Vermischung von
  Zugriffssteuerung und frei definierbaren Datenfeldern.
- Name-Felder (`firstName`/`lastName`/`nickname`), E-Mail und Passwort
  bleiben feste, strukturelle Spalten (analog dazu, dass IT-Schemas `id`,
  `name`, `eventId` als reservierte Keys behandeln) — sie sind
  Identitäts-/Login-Daten, keine "OT-Felder" im fachlichen Sinn dieses Specs.
- Kein `public`-Flag/keine öffentliche Sichtbarkeitsseite für OT-Felder.
- Aktives Bereinigen alter Werte beim Löschen/Umbenennen eines Schema-Felds
  — verhält sich wie bei Charakteren: verwaiste Werte bleiben ungenutzt im
  verschlüsselten Blob liegen, werden nie wieder angezeigt oder validiert.
- Keine Änderung an der bestehenden Sonderlogik für Anmeldungs-Felder
  (eigener Schreibpfad `PUT /events/:id/registrations/:userId/ot-fields`
  mit E-Mail-Benachrichtigung an Orga/Admin bei nachträglicher Änderung,
  siehe `docs/superpowers/specs/2026-09-09-anmeldeformular-ot-felder-design.md`)
  — dieser Pfad bleibt bestehen, wird nur intern schema-getrieben statt
  spaltenweise.

## 4. Datenmodell

### 4.1 Neue Schema-Tabellen (Migration)

Gleiches Muster wie `sc_character_schema`/`nsc_profile_schema`:

```sql
CREATE TABLE account_field_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE registration_field_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'::jsonb
);
```

Je Feld: `{key, label, type, required, options?}` (kein `public`). Erlaubte
`type`-Werte: `text`, `textarea`, `select`, `number`, `boolean`,
`multiselect`, `link`, `date`. Validiert durch dieselbe (ggf. umbenannte,
generische) Funktion wie IT-Schemas, `backend/events/schemaValidation.js`s
`validateSchemaShape`/`validateCharacterData` — reservierte Keys hier:
`['id', 'group']` fürs Konto-Schema, `['id']` fürs Anmeldungs-Schema.

### 4.2 Neue Datenspalten (ein verschlüsselter Blob pro Datensatz)

```sql
ALTER TABLE users ADD COLUMN account_data_enc bytea;
ALTER TABLE invitations ADD COLUMN account_data_enc bytea;
ALTER TABLE registrations ADD COLUMN registration_data_enc bytea;
```

Jede Spalte trägt ein AES-256-GCM-verschlüsseltes JSON-Objekt (`{key:
value}`) über alle Felder des jeweiligen Schemas hinweg — ein Chiffretext
statt bisher 7 (users/invitations) bzw. 6 (registrations) einzelner. Neue
Helfer in `backend/accountFields.js`/`registrationFields.js` (beide
schrumpfen auf diese zwei Funktionen, ersetzen
`decryptEncryptedAccountFields`/`encryptAccountFieldValues` und ihre
Pendants):

```javascript
encryptFieldBlob(values) // -> bytea, JSON.stringify + encryptField
decryptFieldBlob(bytea)  // -> object, decryptField + JSON.parse (null -> {})
```

### 4.3 Migration der Bestandsdaten

Einmaliges Migrationsskript (braucht `ENCRYPTION_KEY` zur Laufzeit, läuft im
selben Task wie der Spaltenwechsel):

1. Für jede Zeile in `users`/`invitations`: die 7 bisherigen
   `*_enc`-Spalten (ohne `group`) einzeln entschlüsseln, zu einem
   `{key: value}`-Objekt zusammensetzen (nur Keys mit nicht-null Wert),
   einmal verschlüsseln, in `account_data_enc` schreiben.
2. Für jede Zeile in `registrations`: analog mit den 6 bisherigen
   `*_enc`-Spalten nach `registration_data_enc`.
3. `account_field_schema`/`registration_field_schema` mit je einer Zeile
   seeden, die exakt die aktuellen Keys/Labels/Typen abbildet (Konto: 7
   Felder als `text`/`textarea`, `birthdate` als neuer `date`-Typ,
   `dataSharingOptOut`/`photoOptOut`... — Anmeldung: 6 Felder, die beiden
   Opt-Outs als `boolean`) — dadurch bleiben bestehende
   `groups.account_fields`-Berechtigungslisten ohne Anpassung gültig.
4. Alte 13 `*_enc`-Spalten droppen (`users`: 7, `invitations`: 7,
   `registrations`: 6 — `invitations` hat dieselben 7 Kontofeld-Spalten wie
   `users`).

Nicht rückgängig zu machen ohne Backup — wie bei jeder vorangegangenen
Spalten-Drop-Migration dieses Projekts zuerst gegen die Dev-DB testen.

### 4.4 Gruppenberechtigung bleibt eine einzige Liste

`groups.account_fields` bleibt **eine** Erlaubnisliste (kein separates
Feld für Anmeldungs-Felder) — genau wie heute, wo
`ALLOWED_ACCOUNT_FIELD_KEYS = [...ACCOUNT_FIELD_KEYS,
...REGISTRATION_FIELD_KEYS]` beide Key-Mengen zu einer Validierungsmenge
vereint (`backend/groups/routes.js`). Der Validator wechselt von der
statischen Konstante auf die Vereinigung der **live** Keys beider Schemas
(`(await getAccountFieldSchema()).map(f => f.key)` ∪ dito für
Registrierung) — Admin kann also weiterhin in `admin/groups.html` einer
Gruppe Zugriff auf beliebige, auch neu angelegte, Konto- oder
Anmeldungsfelder geben, ohne dass sich am Permission-Modell sonst etwas
ändert.

## 5. Backend

- `backend/accounts/repository.js`, `backend/members/repository.js`: SELECT/
  UPDATE verlieren die namentlich ausgeschriebenen `*_enc`-Spalten, lesen/
  schreiben stattdessen `account_data_enc` als Ganzes über
  `decryptFieldBlob`/`encryptFieldBlob`. Wie heute wird der Wert eines
  OT-Felds beim Schreiben nicht typgeprüft (nur die Feld-**Keys** werden
  gegen das aktuelle Schema abgeglichen, um zu entscheiden was überhaupt in
  den Blob übernommen wird — ein unbekannter Key wie `nscData` wird wie
  bisher stillschweigend ignoriert, nicht 400). Nur die Schema-**Definition**
  selbst wird beim Speichern über `/account-schema`/`/registration-schema`
  mit `validateSchemaShape` geprüft, nicht die einzelnen Feldwerte bei jedem
  Schreibzugriff — das wäre eine neue, nicht angefragte Verschärfung
  gegenüber dem heutigen Verhalten (Charakterdaten validieren Werte, weil
  `PUT /characters/:id` ein Full-Replace ist; die OT-Endpunkte sind
  Partial-Updates, bei denen "required" und "unbekanntes Feld" ohnehin nicht
  sauber anwendbar wären).
- `backend/invitations/repository.js`: `createInvitation`/
  `decryptInvitation` verlieren die 7 positional ausgeschriebenen Spalten,
  nutzen denselben Blob-Ansatz. `backend/auth/invite.js`s
  `INSERT INTO users` beim Einlösen kopiert den Blob direkt
  (`account_data_enc = (SELECT account_data_enc FROM invitations ...)`),
  keine Feld-für-Feld-Subqueries mehr nötig.
- `backend/registrations/repository.js`: `registerForEvent`,
  `updateRegistrationOtFields`, `listParticipantsForEvent` wechseln analog
  auf `registration_data_enc`/`decryptFieldBlob`/`encryptFieldBlob`. Der
  bestehende Schreibpfad `PUT /events/:id/registrations/:userId/ot-fields`
  samt E-Mail-Benachrichtigung (siehe Nicht-Ziel) bleibt strukturell
  unverändert, validiert eingehende Werte nur zusätzlich gegen das
  `registration_field_schema`.
- Neue Routen `GET/PUT /account-schema` und `GET/PUT /registration-schema`,
  gleiche `requireAdminGroup`-Gate wie `/sc-schema`/`/nsc-schema`.
- `backend/groups/routes.js`s `isValidFieldList` validiert wie in 4.4
  beschrieben gegen die live geladenen Schema-Keys statt der bisherigen
  statischen Konstanten.

## 6. Frontend

- `admin/character-schema.html` bekommt zwei weitere Tabs ("Konto",
  "Anmeldung") oder wird zu einem allgemeineren
  `admin/feld-schemas.html` — beide Varianten nutzen denselben bereits
  vorhandenen `setupSchemaEditor()`-Baustein, nur mit den neuen Endpunkten
  verdrahtet. Der neue `date`-Typ wird im Typ-`<select>` des Editors
  ergänzt (steht damit auch IT-Schemas zur Verfügung, falls dort mal
  gebraucht).
- `frontend/js/formFields.js`: `renderAccountFieldInput` **bleibt erhalten**
  (CLAUDE.md schützt explizit seine per-Feld `<div class="${key}-container">`-
  Wrapper als bewussten UI-Hook — nicht beim Refactoring entfernen), wird aber
  von `(key, label, value, opts)` auf ein volles Feld-Definitionsobjekt
  `(field, value, opts)` umgestellt (`field = {key, label, type, required,
  options}`, gleiche Form wie IT-Schema-Felder) und um dieselben Typ-Fälle wie
  `renderField` erweitert (`text`, `textarea`, `select`, `number`, `boolean`,
  `multiselect`, `link`, `date`) — jeder Fall weiterhin einzeln in
  `<div class="${key}-container">` gewrappt. Die bisherige Opt-Out-Checkbox-
  Sonderbehandlung (`OPT_OUT_KEYS`/`isOptOutYes`) entfällt, da
  `dataSharingOptOut`/`photoOptOut` im Schema als `type: boolean` geführt
  werden und dieser Fall generisch als Checkbox gerendert wird. Eine neue
  `collectAccountFieldValues(form, schema)` (analog `collectFieldValues`,
  aber mit `data-field`/`id`-Konvention statt `name`-Attributen, wie es die
  bestehenden OT-Formulare heute schon verwenden) liest die Werte zurück.
- `frontend/account.html`, `admin/members.html`, `admin/checkin.html`,
  `frontend/con-anmeldungen.html`: alle Stellen, die heute
  `ACCOUNT_FIELD_LABELS`/`REGISTRATION_FIELD_LABELS` importieren, laden
  stattdessen `GET /account-schema`/`GET /registration-schema` einmalig und
  rendern schema-getrieben (Reihenfolge/Label/Typ kommen aus dem Schema,
  nicht mehr aus einer hartkodierten Konstante).

## 7. Fehlerbehandlung

- `PATCH /account`, `PATCH /members/:id`, `PUT .../ot-fields`: keine
  Typprüfung der Feldwerte (siehe 5.) — unverändert gegenüber heute.
- Schema-PUT (`/account-schema`, `/registration-schema`) mit doppeltem/
  reserviertem Key: 400, gleiche Fehlermeldung wie bei
  `/sc-schema`/`/nsc-schema`.
- Migration schlägt bei nicht gesetztem `ENCRYPTION_KEY` fehl (wie jede
  bestehende Verschlüsselungs-Operation) — kein Sonderfall.

## 8. Tests

- Migrationsskript: Rundlauf alt-verschlüsselte Spalten → Blob, auf
  Testdaten mit Sonderzeichen/Umlauten/leeren Werten.
- `validateSchemaShape` gegen die beiden neuen reservierten-Key-Mengen
  (`['id', 'group']` fürs Konto-Schema, `['id']` fürs Anmeldungs-Schema) —
  analog bestehender `scSchema`/`nscSchema`-Tests.
- `GET/PUT /account-schema`, `GET/PUT /registration-schema`: Admin-Only-Gate,
  Persistenz.
- Bestehende Suiten (`accounts`, `members`, `invitations`, `registrations`,
  `groups`) müssen auf den neuen Blob-Ansatz umgestellt werden, ohne dass
  sich ihr beobachtbares Verhalten ändert (gleiche Werte rein/raus).
- Volle Testsuite (`npm test`) als letzter Schritt des letzten Tasks.

## 9. Migrationsreihenfolge / Risiko

Größtes Risiko ist der Spalten-Drop in 4.3 Schritt 4 — nicht rückgängig zu
machen ohne Backup. Wie bei allen bisherigen Spalten-Drop-Migrationen dieses
Projekts: erst gegen die lokale Dev-DB (`docker-compose.dev.yml`) verifizieren,
dann erst auf Produktion. Migration und alle betroffenen Backend-Konsumenten
gehören in denselben Task (gleiche Regel wie in den vorangegangenen
OT-Feld-Migrationen dieses Projekts).

**Akzeptierter Nebeneffekt des Ein-Blob-Modells**: Die heutige
spaltenweise `COALESCE`-UPDATE ist pro Feld atomar und race-frei. Ein
Blob-Feld lässt sich nicht mehr per SQL `COALESCE` mergen (die Menge der
Keys ist dynamisch) — `updateAccount`/`updateMember`/
`updateRegistrationOtFields` lesen den aktuellen Blob, mergen die
übergebenen Felder in JS und schreiben ihn zurück. Zwei gleichzeitige
`PATCH`-Aufrufe, die unterschiedliche Felder desselben Kontos ändern,
können sich dadurch überschreiben (last write wins) — ein neues,
akzeptiertes Risiko dieses Modells, in der Praxis vernachlässigbar (kein
Multi-Device-Parallel-Editing-Anwendungsfall in dieser App). Nicht mit
einer Locking-Lösung abgefangen; falls das je zum echten Problem wird, ist
ein optimistisches `WHERE account_data_enc = $vorher`-Compare-and-swap der
naheliegende Fix.
