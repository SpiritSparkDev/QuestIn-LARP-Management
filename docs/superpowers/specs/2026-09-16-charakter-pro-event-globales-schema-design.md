# Charakter-pro-Event + globales SC-Schema — Design Spec

## 1. Problem

Die UI/UX-Analyse des aktuellen Registrierungs-/Charakter-Flows (Konto
anlegen → Charakter anlegen → Event-Anmeldung, sowie Verwaltung mehrerer
Charaktere) hat zwei zusammenhängende Probleme aufgedeckt:

1. **Drei uneinheitlich sauber getrennte Datentöpfe.** Konto-Stammdaten
   (`ACCOUNT_FIELD_LABELS`, account-weit) und Registrierungs-OT-Felder
   (`REGISTRATION_FIELD_LABELS`, korrekt pro Anmeldung) sind inhaltlich
   sauber geschnitten. Der dritte Topf, die Charakter-Sheet-Felder, ist
   das aber nicht: seit der Entkopplung von Charakter und Con-Anmeldung
   (`docs/superpowers/specs/2026-09-08-charakter-con-anmeldung-entkoppeln-design.md`,
   Migration 028) ist ein SC-Charakter account-weit und für beliebig
   viele Events anmeldbar. `characters.data` ist dabei ein einziges
   geteiltes JSON-Blob; `updateCharacter()`
   (`backend/characters/repository.js`) merged neue Werte hinein
   (`{...character.data, ...data}`), sodass gleichnamige Felder aus
   unterschiedlichen Events' `character_form_schema` sich gegenseitig
   überschreiben, sobald derselbe Charakter für ein zweites Event mit
   abweichendem Schema angemeldet wird.
2. **Charakterdarstellung.** Charakterkarten (`account.html`) zeigen nur
   Name + Sheet-Tags. Kein Bezug, für welches Event der Charakter
   angemeldet ist; „Bearbeiten" ändert ausschließlich den Namen (Sheet-
   Felder sind nur indirekt über eine laufende Event-Anmeldung
   editierbar); kein Löschen; ein frisch angelegter Charakter zeigt eine
   leere Tag-Liste, die nach einem Fehler statt nach „noch nicht befüllt"
   aussieht.

Diese Spec dreht die Entkopplungs-Entscheidung vom 08.09. für SC/GSC-
Charaktere gezielt zurück und ersetzt gleichzeitig das pro Event
gepflegte `character_form_schema` durch ein einziges globales Schema —
mit der Begründung, dass eine App-Instanz i.d.R. für eine Orga/Event-
Reihe verwendet wird und die Felder sich zwischen deren Events kaum
unterscheiden sollten.

## 2. Ziel

- Ein SC/GSC-Charakter ist ab jetzt **höchstens einer** `registrations`-
  Zeile zugeordnet, gleichzeitig — analog zu einer klassischen
  "Charakterbogen pro Con"-Vorstellung. Für ein weiteres Event braucht es
  einen neuen (ggf. aus dem alten kopierten) Charakter.
- Das Charakter-Sheet-Schema für SC/GSC wird **global** (ein Schema für
  die ganze App-Instanz, admin-editierbar), nicht mehr pro Event. NSC
  hat bereits genau dieses Muster (`nsc_profile_schema`) — SC zieht
  strukturell nach.
- Charaktere-Tab: Anlegen/Bearbeiten zeigt sofort alle globalen Sheet-
  Felder (nicht mehr nur den Namen); Löschen wird möglich; jede Karte
  zeigt ihren Event-/Rollen-Bezug oder „Noch keinem Event zugeordnet";
  ein „Aus bestehendem Charakter kopieren"-Button legt eine unabhängige
  Kopie eines (auch schon verwendeten) eigenen Charakters an.
- Anmeldeformular verliert die event-spezifischen `dynamicFields`
  komplett (Sheet-Pflege ist jetzt Sache des Charaktere-Tabs) und filtert
  die Charakterauswahl auf noch unbenutzte Charaktere der passenden
  Klasse.
- Der fehlende Admin-Editor für `nsc_profile_schema` (Backend-Endpunkt
  existiert, keine Frontend-Seite) wird bei der Gelegenheit mitgebaut:
  eine neue, generische Schema-Verwaltungsseite bedient SC **und** NSC
  über einen Klassen-Umschalter, statt zwei separate Editoren zu bauen.

## 3. Nicht-Ziel

- NSC-Verhalten ändert sich inhaltlich nicht: weiterhin account-weit,
  beliebig oft wiederverwendbar, ein globales Schema (nur jetzt über die
  neue gemeinsame Admin-Seite gepflegt statt gar keine Oberfläche zu
  haben).
- Konto-Stammdaten (`/account`) und Registrierungs-OT-Felder
  (`REGISTRATION_FIELD_LABELS`, `/events/:id/registrations/:userId/ot-fields`)
  bleiben unverändert — deren Trennung war bereits korrekt.
- Keine Änderung an Sidebar/Theming (`docs/superpowers/specs/2026-09-10-sidebar-sahara-redesign-design.md`
  bleibt ein unabhängiges, separates Vorhaben).
- Keine Datei-Kopie beim „Aus bestehendem Charakter kopieren": Datei-
  Uploads (`character_files`, eigener Consent-Flow pro Datei) werden
  bewusst nicht mitkopiert — die Kopie startet ohne Dateien, der Nutzer
  lädt bei Bedarf neu hoch.
- Kein Wechsel des Charakters/der Klasse einer bestehenden, bereits
  bestätigten Anmeldung — wie schon in der 08.09.-Spec festgehalten,
  bleibt „abmelden (nur `pending`) + neu anmelden" der Weg.
- Keine harte DB-Constraint für „ein SC-Charakter hat höchstens eine
  Registrierung" (siehe 4.3 für die Begründung) — Durchsetzung auf
  Anwendungsebene reicht für die erwartete Nutzungsgröße dieser App.

## 4. Datenmodell

### 4.1 `sc_character_schema` (neu)

Exakt nach dem Muster von `nsc_profile_schema`
(`backend/nscSchema/repository.js`): eine Zeile, eine `schema`-JSONB-
Spalte.

```sql
CREATE TABLE sc_character_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);
```

`backend/scSchema/repository.js` + `backend/scSchema/routes.js` sind
1:1-Kopien von `nscSchema/repository.js` + `nscSchema/routes.js`
(`getScCharacterSchema`/`setScCharacterSchema`, Routen `GET /sc-schema`
authentifiziert, `PUT /sc-schema` admin-only, Validierung über das
bestehende `validateSchemaShape`).

### 4.2 `events.character_form_schema` entfällt

Nach der Datenmigration (4.4) wird die Spalte gedroppt:

```sql
ALTER TABLE events DROP COLUMN character_form_schema;
```

`backend/events/repository.js`/`routes.js` verlieren alle Referenzen
darauf; `admin/events.html` verliert den Schema-Editor-Abschnitt
komplett (Zeilen rund um `schema-rows`/`addSchemaRow`, siehe 4.1 im
alten Code).

### 4.3 „Höchstens eine Registrierung" pro SC/GSC-Charakter

Keine neue Spalte, keine DB-Constraint — eine `UNIQUE`-Regel auf
`registrations.character_id` würde NSC (weiterhin mehrfach verwendbar)
brechen, und ein bedingter Constraint bräuchte eine Trigger- oder
partielle-Index-Lösung, die für den erwarteten Anmeldungs-Umfang dieser
App unverhältnismäßig ist. Stattdessen: Anwendungsebene.

`backend/characters/repository.js` bekommt eine neue Prüfung
`isCharacterAlreadyRegistered(characterId)`
(`SELECT 1 FROM registrations WHERE character_id = $1 LIMIT 1`), die
`backend/registrations/routes.js`s Anmelde-Handler vor dem Erzeugen der
Registrierung aufruft, wenn `conRole` eine Charakterklasse mit
Einmal-Regel ist (`sc`, `gsc` — nicht `nsc`). Treffer → `409` mit
Klartextfehler („Dieser Charakter ist bereits für ein anderes Event
angemeldet."). Ein `unregisterFromEvent`-Aufruf (nur `status='pending'`)
löscht die `registrations`-Zeile und macht den Charakter dadurch
automatisch wieder frei — keine zusätzliche Statuspflege nötig.

### 4.4 Migration 032

Schritte, in dieser Reihenfolge:

1. `CREATE TABLE sc_character_schema` (4.1).
2. Globales Schema befüllen: `character_form_schema` des aktuell
   aktiven Events (`is_active = true`) als Startwert übernehmen. Gibt es
   kein aktives Event, bleibt das globale Schema leer (Admin pflegt es
   danach manuell über die neue Seite).
3. **Mehrfach verlinkte SC-Charaktere aufsplitten:** für jeden
   `class='sc'`-Charakter mit mehr als einer `registrations`-Zeile wird
   je zusätzlicher Zeile eine unabhängige Kopie
   (gleicher `name`, gleicher `data`-Stand zum Migrationszeitpunkt)
   angelegt und diese `registrations.character_id` auf die Kopie
   umgehängt. Die älteste Registrierung (`created_at ASC`) behält das
   Original.
4. Für jeden verbleibenden `class='sc'`-Charakter: `data` gegen das neu
   übernommene globale Schema filtern (Felder, die darin nicht
   vorkommen, werden verworfen — betrifft nur Altdaten aus Event-Schemas,
   die nicht dem des aktiven Events entsprachen).
5. `events.character_form_schema`-Spalte droppen (4.2).

Kein Rollback vorgesehen (wie bei den bisherigen Migrationen dieses
Projekts) — Schritt 3 ist die einzige datenverändernde Operation
(INSERT + UPDATE, kein DELETE), Schritt 4/5 sind zerstörend bezüglich
der gedroppten Spalte bzw. gefilterter Alt-Felder. Vor dem Deploy:
`SELECT id, name, data FROM characters WHERE class='sc'` gegen die
Produktionsdaten prüfen, ob Schritt 4 unerwartet viele Felder verwirft
(Hinweis für den Rollout, siehe Abschnitt 8 der Vorgänger-Spec-Praxis
dieses Projekts).

## 5. Backend: `backend/characters/routes.js` & `repository.js`

- `updateCharacter()` verliert den `eventId`-Parameter und die Merge-
  Logik für SC/GSC komplett. Neue Signatur:
  `updateCharacter(id, userId, { name, data })`. Für `class='sc'` wird
  `data` bei jedem Speichern vollständig gegen `sc_character_schema`
  validiert (`validateCharacterData`, wie heute schon für NSC) und
  **ersetzt** (kein Merge mehr) — konsistent mit dem NSC-Pfad, der
  bereits so funktioniert.
- `createCharacter()`: `class='sc'` darf ab jetzt optional `data` direkt
  bei Anlage mitgeben (validiert gegen `sc_character_schema`), statt
  hart auf `'{}'` zu INSERTen — das Anlage-Formular zeigt jetzt sofort
  alle Sheet-Felder (siehe 6).
- Neuer Endpunkt `DELETE /characters/:id` (fehlte bisher komplett):
  nur Eigentümer oder elevated User; 403 sonst; 404 falls nicht
  vorhanden. Blockiert (409) wenn der Charakter mit einer Registrierung
  im Status `confirmed`/`checked_in`/`checked_out` verknüpft ist (nur
  `pending`/keine Registrierung → löschbar, damit eine bestätigte
  Anmeldung nicht durch Löschen ihres Charakters verwaist).
- `PUT /events/:eventId/register` (bzw. das bestehende Registrierungs-
  Handling in `backend/registrations/routes.js`): neue 409-Prüfung aus
  4.3 vor dem Insert.
- `GET /characters`: Response-Objekte für `class='sc'` bekommen ein
  neues, abgeleitetes Feld `registeredFor: { eventId, eventName,
  conRole } | null` (Join über `registrations`), das der Charaktere-Tab
  für den Status-Badge und die „nur unbenutzte Charaktere"-Filterung im
  Anmeldeformular braucht.

## 6. `frontend/account.html` — Charaktere-Unterschritt

- **Anlegen/Bearbeiten-Formular** (`character-form`) rendert ab sofort
  wie das NSC-Formular schon heute die vollen Schema-Felder
  (`renderField`/`collectFieldValues` gegen das per `GET /sc-schema`
  geladene globale Schema), nicht mehr nur `name`. „Bearbeiten" befüllt
  entsprechend alle Felder, nicht mehr nur den Namen.
- **Kartenstatus:** `renderCharacterList()` zeigt pro Karte
  `c.registeredFor` als Zeile „Für {eventName} als {conRoleLabel}
  angemeldet" oder „Noch keinem Event zugeordnet".
- **Löschen-Button** je Karte, ruft `DELETE /characters/:id`; bei 409
  (blockiert durch bestätigte Anmeldung) zeigt die Fehlermeldung des
  Backends an.
- **„Aus bestehendem Charakter kopieren"**-Button oberhalb der Liste:
  öffnet eine einfache Auswahl (Dropdown/Liste) der eigenen SC/GSC-
  Charaktere (auch bereits verwendete), übernimmt `data` unverändert in
  ein vorbefülltes Anlage-Formular mit editierbarem, initial identischem
  Namen — normaler `POST /characters`-Aufruf, keine neue Route.

## 7. `frontend/account.html` — Anmelden-Unterschritt

- `populateCharacterOptions()` filtert zusätzlich auf
  `c.registeredFor === null` (aus 5) für `sc`/`gsc`-Rollen — bereits
  verwendete Charaktere erscheinen nicht mehr im Dropdown. Für `nsc`
  bleibt der Filter unverändert (weiter alle eigenen NSC-Charaktere).
- `renderDynamicFieldsForSelection()`, `dynamicFields`-Container und der
  zugehörige `PUT /characters/:id { eventId, data }`-Aufruf beim
  Registrieren entfallen ersatzlos — das Anmeldeformular besteht danach
  nur noch aus Event, Rolle, Charakterauswahl und den (unveränderten)
  Registrierungs-OT-Feldern.
- 409-Fehler aus 4.3 (Charakter zwischenzeitlich anderweitig belegt,
  z.B. zweiter Tab) werden wie jeder andere Anmeldefehler über
  `registrationMessage` angezeigt.

## 8. Neue Admin-Seite: Charakter-Schema

- Neue Seite `frontend/admin/character-schema.html`, neuer Nav-Eintrag
  (`frontend/js/nav.js`, admin/moderator-only wie die übrigen
  Admin-Seiten).
- Ein Klassen-Umschalter (Tabs „SC/GSC" / „NSC") lädt/speichert
  `GET/PUT /sc-schema` bzw. `GET/PUT /nsc-schema` — derselbe Schema-
  Row-Editor (Key/Label/Typ/Pflichtfeld/Öffentlich/Optionen), 1:1 aus
  `admin/events.html` extrahiert (`addSchemaRow`, `collectSchema`,
  „Auf Standard zurücksetzen" über `DEFAULT_CHARACTER_SCHEMA` nur für
  den SC-Tab, da NSC keinen Default-Schema-Datensatz hat).
- `admin/events.html` verliert den kompletten Schema-Editor-Abschnitt
  (siehe 4.2); das Event-Formular endet mit den bisherigen Feldern vor
  dem Schema-Editor.

## 9. Betroffene Tests

- `tests/integration/characters.test.js` (existiert bereits): neue
  Fälle für `DELETE /characters/:id`, 409 bei Mehrfach-Registrierung,
  Merge-Entfernung (data wird ersetzt statt gemerged), `createCharacter`
  mit `data`.
- `tests/integration/registrations.test.js` (existiert bereits): 409 bei
  „Charakter schon anderweitig registriert", entfernte
  `dynamicFields`-Roundtrip-Fälle (PUT mit `eventId`) durch den neuen
  Ablauf ersetzen.
- Neuer `tests/integration/scSchema.test.js`, 1:1 nach dem Muster von
  `tests/integration/nscSchema.test.js` (existiert bereits).
- Migration-Test/-Skript, das Schritt 3 (Aufsplitten) gegen Fixture-
  Daten mit einem mehrfach verlinkten Charakter prüft.
- Kein Frontend-Test-Setup vorhanden (Projekt-Konvention) — UI-
  Verifikation manuell im Dev-Server, wie in den Vorgänger-Specs.

## 10. Rollout-Risiko

- Migration 032 Schritt 4 (Feld-Filterung) ist die einzige potenziell
  verlustbehaftete Operation — betrifft ausschließlich Sheet-Felder von
  SC-Charakteren, die einem *anderen* als dem aktiven Event zugeordnet
  waren und im übernommenen Schema nicht vorkommen. Vor Deploy die
  Produktionsdaten sichten (Abschnitt 4.4).
- Anwendungsseitige statt DB-seitige Durchsetzung der Einmal-Regel
  (4.3) bedeutet ein theoretisches Race (zwei parallele Tabs melden
  denselben Charakter gleichzeitig an) — bei der Nutzungsgröße dieser
  App (Vereinsanwendung, kein Hochlast-Checkout) akzeptiert, analog zur
  bestehenden Praxis dieses Projekts (z.B. `updateCharacter`s
  Optimistic-ohne-Lock-Ansatz).
