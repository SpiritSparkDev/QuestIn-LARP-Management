# Charakter-Klassen & Hardening — Design Spec

**Vorgänger-Specs:** `docs/superpowers/specs/2026-08-24-teilnehmerregistrierung-design.md`,
`docs/superpowers/specs/2026-08-26-gruppen-berechtigungen-design.md`,
`docs/superpowers/specs/2026-08-27-sc-nsc-profilfelder-design.md`

Dieser Spec bündelt fünf zusammenhängende Änderungen, die im Nachgang zu Plan 4
(NSC Profile & SC Fields) besprochen wurden: die Einführung von "Charakter-Klassen"
(SC/NSC) als vereinheitlichtes Datenmodell, Status-Override beim Check-In,
Rate-Limiting auf den Auth-Endpoints, Namenskollisionsschutz in Schema-Feldern,
und drei offene technische Schulden.

## 1. Charakter-Klassen (SC/NSC)

### Ziel

Aktuell gibt es zwei getrennte, inkonsistente Charakter-Konzepte: SC-Charaktere
(`characters`-Tabelle, an ein Event gebunden, Formular kommt vom Event) und
NSC-Profile (`users.nsc_data`, ein einzelner Blob pro Nutzer, gerade erst in
Plan 4 gebaut, Formular kommt aus der globalen `nsc_profile_schema`-Tabelle).
Das wird zu einem einzigen Konzept "Charakter" mit einer `class`-Eigenschaft
(`sc` oder `nsc`) vereinheitlicht:

- **SC-Klasse** (Gruppen `sc`, `gsc`): Charaktere bleiben an ein Event gebunden,
  Formular kommt vom Event (`events.character_form_schema`) — unverändert zu heute.
- **NSC-Klasse** (Gruppe `nsc`): Charaktere sind account-weit, eventübergreifend
  gültig (kein `event_id`), Formular kommt aus der globalen
  `nsc_profile_schema`-Tabelle — inhaltlich identisch zu Plan 4, aber jetzt als
  echte Charaktere statt als Account-Feld.

Beide Klassen erlauben **mehrere Charaktere pro Nutzer** (Ersatzcharaktere) —
keine Eindeutigkeitssperre auf `(user_id, event_id)`. Das war eine offene
Design-Frage seit dem Events-&-Charaktere-Plan; hiermit entschieden: mehrere
Charaktere sind gewollt.

Welche Gruppe welche Klasse(n) anlegen darf, ist **pro Gruppe konfigurierbar**
(wie `visible_menus`/`account_fields` schon heute), nicht fest auf Gruppennamen
verdrahtet — das behebt zugleich die in Plan 4 aufgefallene Schwäche, dass der
NSC-Zugriff über den literalen String `'nsc'` geprüft wurde.

### Datenmodell

**Neue Spalte auf `groups`:**

```sql
ALTER TABLE groups ADD COLUMN character_classes jsonb NOT NULL DEFAULT '[]';

UPDATE groups SET character_classes = '["sc"]'::jsonb
WHERE key IN ('sc', 'gsc') AND NOT (character_classes @> '["sc"]'::jsonb);

UPDATE groups SET character_classes = '["nsc"]'::jsonb
WHERE key = 'nsc' AND NOT (character_classes @> '["nsc"]'::jsonb);
```

(Gleiches Muster wie die `pronomen`-Migration aus Plan 4: ein `db/groupDefaults.js`-Edit
allein würde nur eine neue Datenbank betreffen, nicht die bereits geseedeten Zeilen.)

`db/groupDefaults.js` bekommt `characterClasses: ['nsc']` bei `nsc`,
`characterClasses: ['sc']` bei allen 7 übrigen Gruppen (`sc`, `gsc`, Admin,
Orga, Plot-Orga, SL, Hilfs-SL). **Korrektur gegenüber einem ersten Entwurf:**
nicht `[]` bei den 5 Nicht-Spieler-Gruppen — heute darf jeder authentifizierte
Nutzer SC-Charaktere anlegen (bestätigt u. a. durch den bestehenden Test
"ein Admin kann für ein inaktives Event einen Charakter anlegen" in
`tests/integration/characters.test.js`), diese neue Berechtigungsprüfung soll
das nicht rückwirkend einschränken. Nur der NSC-Zugriff ist eine echte neue
Einschränkung (heute existiert dafür noch kein Konzept). Jederzeit über die
Gruppen-Verwaltung erweiterbar.

**`characters`-Tabelle erweitert:**

```sql
ALTER TABLE characters ADD COLUMN class text NOT NULL DEFAULT 'sc' CHECK (class IN ('sc', 'nsc'));
ALTER TABLE characters ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE characters ADD CONSTRAINT characters_class_event_check
  CHECK ((class = 'sc' AND event_id IS NOT NULL) OR (class = 'nsc' AND event_id IS NULL));
```

**Migration bestehender NSC-Profile** (separate Migration, da echte Datenmigration
+ destruktive Spalten-Löschung, analog zur Trennung von 008/009 in Plan 4):

```sql
INSERT INTO characters (user_id, event_id, class, name, data)
SELECT id, NULL, 'nsc', name, nsc_data
FROM users
WHERE nsc_data IS NOT NULL AND nsc_data::text != '{}';

ALTER TABLE users DROP COLUMN nsc_data;
```

Der neue Charakter-Name für migrierte NSC-Profile ist der Account-Name des
Nutzers (kein eigenes Namensfeld existierte vorher) — Nutzer können ihn nach
der Migration wie jeden anderen Charakternamen ändern. `nsc_profile_schema`
bleibt unverändert bestehen und wird weiterhin als das globale NSC-Klassen-Schema
verwendet — nur die Stelle, wo die *Daten* eines einzelnen Nutzers liegen,
ändert sich (`users.nsc_data` → `characters.data` mit `class='nsc'`).

### API

- `POST /characters` bekommt ein Pflichtfeld `class` (`'sc'` oder `'nsc'`).
  Bei `class: 'sc'` bleibt `eventId` Pflicht wie bisher, validiert gegen
  `event.character_form_schema`. Bei `class: 'nsc'` darf `eventId` nicht gesetzt
  sein, validiert gegen die aktuelle `nsc_profile_schema`. Neue Berechtigungsprüfung:
  `user.group.characterClasses.includes(class)`, sonst 403.
- `PUT /characters/:id` liest die Zielschema-Quelle jetzt anhand
  `character.class` (nicht mehr blind über das Event), damit NSC-Charaktere
  korrekt validiert werden können.
- `GET /characters` liefert weiterhin alle Charaktere des Nutzers, jetzt inklusive
  `class`-Feld — die Aufteilung nach Klasse übernimmt das Frontend.
- `GET /nsc-schema`s Leserecht wechselt von `user.group.key === 'nsc'` auf
  `user.group.characterClasses.includes('nsc')` — konsistent mit der neuen,
  datengetriebenen Zugriffsregel.
- `PATCH /account`s `nscData`-Behandlung (aus Plan 4 Task 4) entfällt ersatzlos
  — NSC-Daten laufen jetzt über die normale Charakter-CRUD-API. Das ist eine
  bewusste Rückabwicklung eines Teils von Plan 4 (siehe Hinweis unten).
- `requireAuth` (bzw. der zentrale Query, der `user.group` befüllt) bekommt
  `characterClasses` zusätzlich zu `visibleMenus`/`accountFields`/`canEditCharacters`.

### Frontend

`frontend/characters.html` wird die alleinige Stelle für beide Klassen: die
bestehende Event-Auswahl + Formular bleibt für SC-Charaktere; ein zweiter,
eventunabhängiger Abschnitt (sichtbar wenn `account.group.characterClasses`
`'nsc'` enthält) erlaubt das Anlegen/Bearbeiten mehrerer NSC-Charaktere, analog
zur bisherigen Formular-Logik aus Plan 4 (`renderField`/`collectFieldValues`
gegen das `GET /nsc-schema`-Ergebnis). Der NSC-Abschnitt auf `frontend/account.html`
(Zeilen 36-40, 71-86 im aktuellen Stand) entfällt komplett.

### Hinweis: Rückabwicklung von Plan-4-Arbeit

Plan 4 hat `users.nsc_data` + `PATCH /account`-Handling + den NSC-Abschnitt auf
`account.html` gerade erst gebaut und gemergt. Dieser Plan macht das nicht
"falsch" — die Anforderung war beim Schreiben von Plan 4 noch nicht klar
("mehrere NSC-Charaktere pro Nutzer" kam erst mit diesem Spec auf) — aber es ist
eine echte Rückabwicklung: die betroffenen Dateien
(`backend/accounts/routes.js`, `backend/accounts/repository.js`,
`frontend/account.html`) werden in diesem Plan wieder angefasst und teilweise
zurückgebaut. Unkritisch, da Plan 4 noch nicht produktiv genutzt wurde.

## 2. Namenskollisionsschutz in Schema-Feldern

`isValidCharacterFormSchema` (`backend/events/routes.js:7`) und
`isValidSchemaShape` (`backend/nscSchema/routes.js:7`) sind aktuell
byte-identisch dupliziert und prüfen nur, dass jedes Feld ein nicht-leeres
`key`-Textfeld hat. Beide werden durch eine gemeinsame Funktion ersetzt
(sinnvoller Ort: `backend/events/schemaValidation.js`, wo `validateCharacterData`
schon lebt), die zusätzlich:

- `key` gegen eine Sperrliste prüft (`['id', 'name']` — beides kollidiert mit
  Feldern, die jedes Charakter-/Account-Formular ohnehin schon hat), und
- innerhalb eines Schemas auf doppelte `key`-Werte prüft.

Diese eine Funktion greift dann bei `PUT /events/:id` (Event-Schema-Speichern)
UND bei `PUT /nsc-schema` — schließt die Lücke an beiden aktuellen
Schema-Eingabepunkten und jedem zukünftigen.

## 3. Status-Override mit Bestätigung (Check-In)

### Ziel

Admin, Orga und SL sollen den Anmeldestatus eines Teilnehmers (`registered` /
`checked_in` / `checked_out`) frei setzen können — nicht nur den linearen
Vorwärts-Pfad (`registered → checked_in → checked_out`), den
`backend/registrations/statusMachine.js` heute erzwingt. Ein Rücksetzen (jeder
Schritt, der NICHT der normale Vorwärts-Übergang ist) fragt vorher per Dialog
"Bist du sicher?" nach; der normale Check-In/Check-Out-Ablauf bleibt wie bisher
ohne Nachfrage.

### Datenmodell

Neue Gruppen-Berechtigung, nach demselben Muster wie `can_edit_characters`:

```sql
ALTER TABLE groups ADD COLUMN can_override_checkin_status boolean NOT NULL DEFAULT false;

UPDATE groups SET can_override_checkin_status = true
WHERE key IN ('admin', 'orga', 'sl') AND can_override_checkin_status = false;
```

`db/groupDefaults.js`: `canOverrideCheckinStatus: true` bei `admin`/`orga`/`sl`,
`false` bei den übrigen. Bewusst als Gruppen-Einstellung (nicht als
`user.group.key === 'admin' || ... === 'orga' || ... === 'sl'`-Vergleich im
Code) — vermeidet exakt das Muster, das beim `'nsc'`-String-Vergleich in
Plan 4 als Schwäche aufgefallen ist.

### API

Neuer Endpunkt `PUT /events/:id/checkin/:userId`, Body `{ status: 'registered'
| 'checked_in' | 'checked_out' }`, gated auf `requireMenu('checkin')` UND
`user.group.canOverrideCheckinStatus`. Setzt den Status direkt (kein
`applyTransition`-Kettenzwang), mit demselben nebenläufigkeitssicheren
Update-Muster wie die bestehende `transitionStatus`-Funktion
(`backend/registrations/repository.js:101-127` — `UPDATE ... WHERE status = $currentStatus`
gegen ein gleichzeitiges Ändern absichern).

### Frontend

`admin/checkin.html` bekommt zusätzlich zu den bestehenden Check-In/Check-Out-Knöpfen
(nur sichtbar wenn `account.canOverrideCheckinStatus` true ist) eine Möglichkeit,
den Status direkt zu setzen. Zielt der Klick auf einen Rückwärts-Schritt
(`checked_in`/`checked_out` → ein "früherer" Status), erscheint vorher
`confirm('Bist du sicher?')`; beim normalen Vorwärts-Schritt nicht.

## 4. Rate-Limiting

### Ziel

Login, Register, Password-Reset (und die drei OAuth-Start-Routen) bekommen ein
Rate-Limit — vor einem echten Live-Launch nötig, bisher komplett unbeschränkt
(bestätigt: kein Treffer für "rate limit" im gesamten Backend).

### Ansatz

Ein einfacher In-Memory-Fixed-Window-Limiter (kein Redis, keine neue Dependency
— passt zum Rest dieses Projekts: eine Instanz, Node-Stdlib reicht), als
Middleware im selben Kompositions-Stil wie `requireAuth`/`requireMenu`. Zwei
Schlüssel-Dimensionen:

- **Pro IP** — greift bei allen Endpoints (Register, Login, Password-Reset,
  OAuth-Start), verhindert simples Durchprobieren von einer Quelle aus.
- **Zusätzlich pro E-Mail beim Login** — verhindert gezieltes Durchprobieren
  gegen ein bestimmtes Konto von wechselnden IPs aus.

Grenzwerte (z. B. 10 Versuche/15 Minuten pro IP, 5 Versuche/15 Minuten pro
E-Mail beim Login) sind ein Implementierungsdetail für den Plan, keine
Architekturfrage.

## 5. Technische Schulden

### 5.1 HTTP-Server-Leck in Tests

10 von 15 Integrationstest-Dateien (`auth-login`, `characters`,
`auth-password-reset`, `auth-register`, `events`, `checkin`, `registrations`,
`oauth`, `server`, `staticFiles`) rufen `server.close()` ohne `try/finally`
auf — schlägt eine Assertion vorher fehl, bleibt der Server offen und
`node --test` kann hängen bleiben. Lösung: ein gemeinsamer Test-Helper
`withTestServer(async (port) => { ... })` (neue Datei, z. B.
`tests/testServer.js`), der `createServer().listen(0)` kapselt und
`server.close()` intern immer in einem `finally` aufruft. Die 5 neueren
Testdateien (`groups`, `members`, `accounts`, `invitations`, `nscSchema`) haben
das Muster schon von Hand korrekt umgesetzt und können bei Gelegenheit auf den
Helper umgestellt werden, müssen es aber nicht (kein Bug dort, nur
Vereinheitlichung).

### 5.2 Groups-DDL im Seed-Skript statt in einer echten Migration

`db/seedGroups.js:49-50` führt `ALTER TABLE users ALTER COLUMN group_id SET NOT
NULL` und `ALTER TABLE users DROP COLUMN role` direkt aus, außerhalb von
`db/migrate.js`s Transaktions-/Advisory-Lock-Schutz. Lösung: eine neue,
in sich geschlossene Migration, die die Default-Gruppen per SQL einfügt
(`ON CONFLICT DO NOTHING`, dieselben Keys wie `db/groupDefaults.js` — einmalig
dupliziert, macht die Migration aber unabhängig von der Ausführungsreihenfolge
mit dem Seed-Skript), den `role`→`group_id`-Backfill übernimmt, dann
`SET NOT NULL` und `DROP COLUMN role` setzt. `db/seedGroups.js` verliert danach
diese drei Zeilen und beschränkt sich auf reine Konfigurationspflege.

### 5.3 Charaktere ohne Eindeutigkeitssperre

Durch Abschnitt 1 dieses Specs erledigt — keine separate Änderung nötig.

## Offene Punkte für die Plan-Schreibphase

- Exakte Rate-Limit-Werte (Versuche/Zeitfenster) — Implementierungsdetail, keine
  Design-Entscheidung.
- Ob `withTestServer` auf die 5 bereits korrekten Testdateien rückwirkend
  angewendet wird oder nur für die 10 betroffenen — Empfehlung: nur die 10
  betroffenen umstellen, die 5 korrekten unangetastet lassen (kein Bug dort).
- Reihenfolge/Anzahl der Migrationen (010, 011, ...) — wird beim Schreiben des
  Plans anhand der dann aktuellen `db/migrations/`-Nummerierung endgültig
  festgelegt.

## Empfohlene Plan-Aufteilung

Dieser Spec ist zu groß für einen einzelnen Plan (mehrere, größtenteils
unabhängige Dateigruppen) — analog zur Gruppen-&-Berechtigungen-Initiative
(1 Spec, 4 Pläne) würde ich vorschlagen:

1. **Charakter-Klassen** (Abschnitt 1 + 2, da Namenskollisionsschutz dieselbe
   Validierungs-Pipeline anfasst) — der größte und am meisten verzahnte Teil.
2. **Check-In-Härtung** (Abschnitt 3, Status-Override) — eigenständig, keine
   Dateiüberschneidung mit Plan 1.
3. **Rate-Limiting** (Abschnitt 4) — vollständig eigenständig.
4. **Technische Schulden** (Abschnitt 5.1 + 5.2) — eigenständig, kann auch
   zuerst laufen, da unabhängig von den anderen drei.

Reihenfolge unter diesen vier ist flexibel; Plan 1 ist der einzige mit echter
Größe, der Rest ließe sich auch parallel/in beliebiger Reihenfolge einschieben.
