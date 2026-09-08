# Charakter/Con-Anmeldung entkoppeln — Design Spec

**Vorgänger-Specs:** `docs/superpowers/specs/2026-09-08-system-con-rollen-design.md` (Teil 1),
`docs/superpowers/specs/2026-08-28-charakterklassen-und-hardening-design.md`

Zweiter von fünf Teilen des User-Testing-Feedback-Pakets. Entkoppelt die
Charaktererstellung von der Event-Anmeldung: Charaktere werden account-weit
(wie NSC-Charaktere es heute schon sind), und eine neue eigenständige Seite
"Con-Anmeldungen" lässt Nutzer aus ihren bestehenden Charakteren wählen, statt
Charaktererstellung und Anmeldung im selben Formular zu erzwingen.

## 1. Problem

SC-Charaktere sind heute (`characters.event_id`, NOT NULL für `class='sc'`,
Migration 011) zwingend an genau ein Event gebunden, schon bei der Erstellung
— das Erstellungsformular auf `characters.html` verlangt eine Event-Auswahl.
Das widerspricht dem Wunsch, dass Charaktere eigenständig existieren und man
bei der Anmeldung aus BESTEHENDEN Charakteren wählt, statt für jedes Event
zwangsläufig neu anzulegen.

## 2. Ziel

- Ein Charakter wird einmal angelegt (nur Name) und existiert unabhängig von
  jedem Event — wie NSC-Charaktere es bereits tun.
- Ein Charakter kann sich für beliebig viele Events anmelden.
- Eine neue, eigenständige Seite `frontend/con-anmeldungen.html` (eigener
  Nav-Eintrag) übernimmt die komplette Anmeldungs-UI (Event wählen, Rolle
  wählen, Charakter wählen, event-spezifische Felder ausfüllen, anmelden) —
  `characters.html` wird auf reine Charakterverwaltung reduziert.
- Ein Charakter kann sich für Events mit unterschiedlichen
  Charakterformular-Schemas anmelden; seine Felder sammeln sich dabei im
  selben `data`-Objekt (Felder aus Event A bleiben erhalten, wenn man sich
  später auch für Event B mit anderem Schema anmeldet).

## 3. Nicht-Ziel (explizit außerhalb dieses Plans)

- Verschieben von `conTage`/`accommodation`/`craftOffer`/`travelMethod` in
  das Anmeldeformular — das bleibt Teil 3.
- **Eine bestehende Anmeldung nachträglich auf einen anderen Charakter
  umstellen.** Wer sich mit dem falschen Charakter angemeldet hat, meldet
  sich ab (nur möglich solange `status='pending'`, bestehende Regel bleibt
  unverändert) und meldet sich erneut mit dem richtigen Charakter an. Eine
  eigene "Charakter wechseln"-Funktion für bereits bestätigte Anmeldungen ist
  bewusst nicht Teil dieses Plans — kann bei Bedarf später ergänzt werden.
- UI-Text-/Typo-Politur (Teil 4) und Regelwerk-Ergänzungen (Teil 5).

## 4. Datenmodell

### 4.1 `characters.event_id` entfällt komplett

```sql
ALTER TABLE characters DROP CONSTRAINT characters_class_event_check;
ALTER TABLE characters DROP COLUMN event_id;
```

Jeder Charakter (`sc` wie `nsc`) ist ab jetzt account-weit. Kein Unterschied
mehr zwischen den beiden Klassen bezüglich Event-Bindung — nur noch, welches
Schema ihre Daten validiert (siehe 4.3).

### 4.2 `registrations.character_id`

```sql
ALTER TABLE registrations ADD COLUMN character_id uuid REFERENCES characters(id);

ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role IN ('sc', 'gsc', 'nsc') AND character_id IS NOT NULL)
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga') AND character_id IS NULL)
  );
```

**Backfill (vor dem CHECK-Constraint, in derselben Migration):** für jede
bestehende Registrierung mit `con_role IN ('sc','gsc')` wird der älteste
`class='sc'`-Charakter desselben Users verknüpft, der noch die (gleich
danach gedroppte) `event_id` dieses Events trägt; für `con_role='nsc'` der
älteste `class='nsc'`-Charakter des Users unabhängig vom Event. `helfer`/
`orga`/`hilfs_orga` bleiben `NULL`. Reihenfolge: Backfill zuerst (braucht
`characters.event_id` noch), danach erst `event_id` droppen (Abschnitt 4.1).

**Sicherheitshinweis für den Rollout** (wie schon in Teil 1 Abschnitt 8):
diese Migration vor dem Merge gegen eine Kopie der aktuellen Dev-Datenbank
testen — falls eine bestehende `sc`/`gsc`/`nsc`-Registrierung keinen
passenden Charakter zum Backfillen findet (z. B. gelöschter Charakter),
schlägt der `NOT NULL`-Teil des CHECK-Constraints fehl und muss vor dem
eigentlichen Merge manuell untersucht werden.

## 5. Backend-Änderungen

### 5.1 Charaktererstellung wird minimal

`backend/characters/repository.js`s `createCharacter` verliert für
`class='sc'` die komplette Event-/Schema-Validierung — nimmt nur noch
`{name}` entgegen, `data` startet leer (`{}`). `class='nsc'` bleibt
unverändert (validiert weiterhin gegen `nsc_profile_schema`, war schon
account-weit).

`backend/characters/routes.js`s `POST /characters`: die `eventId`-Pflicht
und der `event.is_active`-Gate für `class='sc'` entfallen hier komplett
(dieser Gate wandert zur Anmeldung, siehe 5.3).

### 5.2 Event-spezifische Felder werden über `PUT /characters/:id` gepflegt

`updateCharacter(id, userId, { name, data, eventId })`: `name` weiterhin frei
änderbar. Für `data`-Änderungen an einem `class='sc'`-Charakter ist `eventId`
jetzt **Pflicht** — die übergebenen `data` werden als vollständiges Fragment
gegen `event.character_form_schema` validiert (bestehende
`validateCharacterData`, unverändert — sie lehnt unbekannte Keys ab, deshalb
muss das Fragment exakt den Feldern DIESES Events entsprechen, keine
Altlasten anderer Events enthalten) und danach mit den bestehenden
`character.data` gemerged (`{...character.data, ...data}`), nicht ersetzt —
so bleiben Felder aus früheren Anmeldungen für andere Events erhalten. Ohne
`eventId` bei einer `data`-Änderung an einem `sc`-Charakter: `400`. Für
`class='nsc'` bleibt das Verhalten exakt wie heute (validiert gegen
`nsc_profile_schema`, volles Replace, kein `eventId` nötig).

### 5.3 Anmeldung verlangt `characterId`

`backend/registrations/repository.js`:

- `registerForEvent(userId, eventId, conRole, characterId, requestingUser)`
  — neuer Parameter `characterId`. Validierung: `con_role IN
  ('sc','gsc','nsc')` verlangt einen `characterId`, der (a) existiert, (b)
  `character.user_id === userId` ist, (c) die passende Klasse hat (`sc`/`gsc`
  → `class='sc'`, `nsc` → `class='nsc'`); `con_role IN
  ('helfer','orga','hilfs_orga')` verlangt `characterId` sei `null`/nicht
  gesetzt. Der `event.is_active`-Gate aus der alten Charaktererstellung
  (5.1) wird hier neu verankert und dabei bewusst verallgemeinert: er galt
  bisher nur für `sc` (weil Charaktererstellung damals gleichzeitig
  Anmeldung war), gilt jetzt konsequent für alle vier selbstständig
  wählbaren Rollen (`sc`/`gsc`/`nsc`/`helfer`) gleichermaßen — nicht
  privilegierte User dürfen sich mit keiner dieser Rollen für ein inaktives
  Event neu anmelden, nur `canEditCharacters`-User (`moderator`/`admin`)
  dürfen das weiterhin (z. B. um alte Daten nachzupflegen). `orga`/
  `hilfs_orga` bleiben davon unberührt — die sind ohnehin schon über
  `canGrantStaffConRole` gegated.
- **Vereinfachung**: `approveRegistration`s Charakter-Existenz-Prüfung (aus
  Teil 1) entfällt komplett — der neue CHECK-Constraint (4.2) garantiert
  bereits, dass jede `sc`/`gsc`/`nsc`-Registrierung einen `character_id`
  trägt. `approveRegistration` transitioniert direkt, ohne eigene Abfrage.
- `listParticipantsForEvent`/`getScanLookup`: die Charakter-Abfrage
  `SELECT ... FROM characters WHERE event_id = $1` funktioniert nicht mehr
  (Spalte weg) — wird auf einen Join über `registrations.character_id`
  umgestellt: `SELECT c.* FROM characters c JOIN registrations r ON
  r.character_id = c.id WHERE r.event_id = $1 [AND r.user_id = $2]`.
- `backend/characters/repository.js`s `listCharactersForEvent(eventId)`
  (Basis von `GET /events/:eventId/characters/public`, genutzt von
  `characters-browse.html`) wird auf denselben Join umgestellt: `SELECT c.*
  FROM characters c JOIN registrations r ON r.character_id = c.id WHERE
  r.event_id = $1 AND c.class = 'sc'`. Das Response-Format und
  `characters-browse.html` selbst ändern sich nicht — reiner
  Backend-Umbau.

### 5.4 Routen

`backend/registrations/routes.js`s `POST /events/:id/register` liest
zusätzlich `body.characterId` und reicht es an `registerForEvent` durch.

## 6. Frontend-Änderungen

### 6.1 `frontend/characters.html` — reine Charakterverwaltung

Entfernt komplett: `#registration-list`-Tabelle, Rollen-Auswahl,
Register-Button, `loadRegistrations`/`unregister`/alles rund ums Registrieren
(zieht 1:1 nach `con-anmeldungen.html`). Das Erstellungsformular
(`#sc-form-section`) verliert das Event-Dropdown und alle dynamischen
Schema-Felder — nur noch Name-Eingabe. Die Charakterkarten-Ansicht
(`#character-list`) zeigt weiterhin `tagsForCharacter`, aber ohne
Event-Bezug (kein `char-meta`-Event-Name mehr, da ein Charakter jetzt für
mehrere Events stehen kann) — welche Anmeldungen zu einem Charakter gehören,
zeigt ausschließlich `con-anmeldungen.html` (6.2), nicht diese Seite. Der
"Bearbeiten"-Dialog ändert sich auf reine Namensänderung (keine
Datenfelder mehr auf dieser Seite).

### 6.2 Neue Seite `frontend/con-anmeldungen.html`

Eigener Nav-Eintrag (`nav.js`, neuer Menü-Key `con-anmeldungen`, siehe 6.4).
Ablauf:
1. Event wählen (gleiche Sichtbarkeitsregel wie heute: nur aktive Events für
   normale User, alle für `canEditCharacters`).
2. Rolle wählen (sc/nsc/gsc/helfer immer, orga/hilfs-orga wenn berechtigt —
   1:1 aus Teil 1 übernommen).
3. Bei sc/gsc/nsc: einen der eigenen Charaktere mit passender Klasse wählen
   (Dropdown aus `GET /characters`, gefiltert auf `class`); hat der Nutzer
   keinen passenden Charakter, ein Hinweis mit Link zu `characters.html`.
4. Die für das gewählte Event fehlenden/vorhandenen Schema-Felder werden
   angezeigt (vorbefüllt aus `character.data`, soweit vorhanden) — beim
   Speichern zuerst `PUT /characters/:id` mit `{eventId, data}` (schreibt
   die Felder in den Charakter), danach `POST /events/:id/register` mit
   `{conRole, characterId}`.
5. Anmelden-Button nennt das Ziel-Event ("Anmelden für Con 2026" — aus Teil 1
   übernommenes Muster).
6. Bestehende Anmeldungen (heutige "Meine Anmeldungen"-Tabelle) werden hier
   angezeigt, inkl. Abmelden-Button (nur bei `status='pending'`, unverändert).

### 6.3 `GET /characters`/`GET /account`-Response

Keine Änderung nötig — Charaktere kommen weiterhin ohne Event-Bezug.
`con-anmeldungen.html` lädt zusätzlich `GET /registrations` (bestehender
Endpunkt) für die Anmeldungsliste.

### 6.4 `nav.js` + `groups`

Neuer Menü-Key `con-anmeldungen` in `MENU_LINKS` (nav.js) und in
`MENU_KEYS` (`backend/groups/routes.js`s Validierung). Alle 3 Gruppen
(`admin`, `moderator`, `mitglied`) bekommen ihn zu ihren
`visible_menus` hinzugefügt (`db/groupDefaults.js`, `db/seedGroups.js`,
neue Migration, gleiches "retroaktiv gewähren"-Muster wie bei früheren
Menü-Ergänzungen in diesem Projekt).

## 7. Betroffene Tests

Migration/Schema-Tests (`schema-registrations.test.js`,
`schema-users.test.js`-Analogon für die neue Spalte), `characters.test.js`
(Erstellung ohne `eventId`, `PUT` mit/ohne `eventId`, Merge-Verhalten über
zwei verschiedene Event-Schemas hinweg), `registrations.test.js`
(`characterId`-Validierung: fehlt/falsche Klasse/fremder User/korrekt für
alle con_role-Werte, `approveRegistration`-Vereinfachung), `checkin.test.js`
(Teilnehmerliste über den neuen Join), `scanLookup.test.js` (dito),
`groups.test.js`/`seedGroups.test.js` (neuer Menü-Key). Jeder bestehende
Test, der `POST /characters` mit `eventId` für `class='sc'` aufruft, muss
angepasst werden (Aufruf ohne `eventId`, danach ggf. separater `PUT` mit
`eventId`+`data` falls der Test Feld-Daten braucht).

## 8. Rollout-Risiko

Wie in Abschnitt 4.2 beschrieben: die Migration braucht funktionierenden
Backfill für ALLE bestehenden `sc`/`gsc`/`nsc`-Registrierungen, sonst
schlägt der neue CHECK-Constraint fehl. Vor dem Merge gegen eine Kopie der
aktuellen Dev-Datenbank testen (gleiche Regel wie Teil 1 Abschnitt 8 und wie
bei Migration 016 in der Projekthistorie). Kein Datenverlust erwartet außer
der bewusst gedroppten `characters.event_id`-Spalte selbst (deren Information
vollständig in `registrations.character_id` überführt wird, bevor sie
gedroppt wird).
