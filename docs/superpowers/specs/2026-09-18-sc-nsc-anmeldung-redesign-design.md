# SC/NSC-Anmeldung Redesign — Design Spec

## 1. Problem

Das heutige Anmeldeformular (`frontend/account.html`, Registrierungs-Tab) lässt
den Nutzer zunächst eine **Rolle** wählen (`sc`/`nsc`/`gsc`/`helfer`/`orga`/
`hilfs_orga`) und danach — nur für `sc`/`gsc`/`nsc` — einen passenden Charakter.
Das bildet drei Dinge nicht ab, die der Nutzer tatsächlich unabhängig
voneinander entscheiden will:

- **Welchen Charakter spielt er?** Die Charakterauswahl sollte der Startpunkt
  sein, nicht eine Konsequenz der Rollenwahl.
- **Steht er zusätzlich als NSC zur Verfügung?** Das ist heute nur als
  exklusive Alternativrolle (`nsc`) abbildbar, nicht als Ergänzung zu "ich
  komme als mein SC".
- **Ist sein SC ein GSC?** Das wird heute pro Anmeldung neu gewählt
  (`con_role='gsc'`), obwohl es eigentlich eine Eigenschaft des Charakters
  selbst ist (ein GSC bleibt über Events hinweg ein GSC).

## 2. Ziel

- Anmeldeformular zeigt zuerst eine Charakterauswahl ("Als welcher Charakter
  kommst du?": eigene, noch nicht anderweitig registrierte SC-Charaktere, oder
  keiner).
- Ein Toggle "Ich stehe zusätzlich als NSC zur Verfügung" ist unabhängig davon
  wählbar, mit optionaler (nicht zwingender) Auswahl eines konkreten
  NSC-Charakters.
  - Kein SC gewählt + Toggle an → `con_role = 'nsc'` (wie heute, aber
    Charakterauswahl jetzt optional statt Pflicht).
  - SC gewählt + Toggle an → `con_role = 'sc'`, zusätzlich `nsc_available =
    true` (mit optionalem eigenem `nsc_character_id`).
  - SC gewählt + Toggle aus → `con_role = 'sc'` (wie heute).
- GSC ist kein Anmeldungs-Konzept mehr, sondern ein Flag am SC-Charakter
  selbst (`characters.is_gsc`), vom Spieler im Charakterformular unter
  "Charaktere" gesetzt.
- Helfer/Orga/Hilfs-Orga bleiben unverändert als eigene, alternative
  Rollenwahl neben der Charakter/NSC-Auswahl.
- Das "NSC-Charaktere"-Menü ist nur sichtbar, solange der Nutzer bei
  mindestens einer aktuellen Anmeldung `nsc_available = true` oder
  `con_role = 'nsc'` hat.

## 3. Nicht-Ziel (explizit außerhalb dieses Plans)

- Ein Dialog/Vorschlagsmechanismus zwischen NSC-Interessenten und Orga/SL
  (Präferenzen einreichen, Orga schreibt/präsentiert Rollen zurück) — als
  eigene, spätere Idee vermerkt, nicht Teil dieses Umbaus.
- Keine Änderung an Helfer/Orga/Hilfs-Orga-Vergabelogik (`canGrantStaffConRole`
  bleibt unverändert).
- Keine Änderung am SC-Charakterschema-Editor (`sc_character_schema`) — das
  GSC-Flag ist ein fester Systemwert wie `class`, kein admin-definierbares
  Schema-Feld.

## 4. Datenmodell

Neue Migration `db/migrations/036_sc_nsc_anmeldung_redesign.sql`:

```sql
-- 1. GSC wird ein Charakter-Flag statt einer Anmeldungs-Rolle.
ALTER TABLE characters ADD COLUMN is_gsc boolean NOT NULL DEFAULT false;

-- 2. Bestehende gsc-Anmeldungen migrieren: Charakter markieren, con_role auf 'sc'.
UPDATE characters SET is_gsc = true
WHERE id IN (SELECT character_id FROM registrations WHERE con_role = 'gsc');

UPDATE registrations SET con_role = 'sc' WHERE con_role = 'gsc';

-- 3. Neue Spalten für den "SC + zusätzlich NSC-bereit"-Fall.
ALTER TABLE registrations ADD COLUMN nsc_available boolean NOT NULL DEFAULT false;
ALTER TABLE registrations ADD COLUMN nsc_character_id uuid REFERENCES characters(id);

-- 4. Check-Constraint neu fassen: 'gsc' raus, 'nsc' ohne Pflicht-Charakter.
ALTER TABLE registrations DROP CONSTRAINT registrations_character_con_role_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_character_con_role_check
  CHECK (
    (con_role = 'sc' AND character_id IS NOT NULL)
    OR (con_role = 'nsc')
    OR (con_role IN ('helfer', 'orga', 'hilfs_orga') AND character_id IS NULL)
  );
```

`nsc_available`/`nsc_character_id` sind nur bei `con_role = 'sc'` bedeutsam
(siehe 5.1 Validierung); bei jedem anderen `con_role` bleiben sie auf ihrem
Default (`false`/`NULL`).

## 5. Backend-Änderungen

### 5.1 `backend/registrations/repository.js`

- `ALL_CON_ROLES`/`SELF_SERVICE_CON_ROLES`/`CHARACTER_REQUIRED_CON_ROLES`
  verlieren `'gsc'`.
- `resolveCharacterId`: `nsc` wird von "Pflicht-Charakter" auf "optionaler
  Charakter" umgestellt (kein `CHARACTER_REQUIRED`-Fehler mehr bei fehlendem
  `characterId`; ist einer angegeben, bleibt die bestehende Klassen-/
  Eigentums-Prüfung, aber ohne die "nur einmal registriert"-Regel, die auch
  heute schon nur für `class='sc'` gilt).
- Neue Funktion `resolveNscAvailability(userId, conRole, nscAvailable,
  nscCharacterId)`:
  - Ist `conRole !== 'sc'`: `nscAvailable`/`nscCharacterId` müssen leer/false
    sein, sonst `INVALID_NSC_AVAILABILITY`-Fehler (400).
  - Ist `nscCharacterId` gesetzt, aber `nscAvailable` nicht `true`: derselbe
    Fehler (Charakter ohne aktive Verfügbarkeit ist inkonsistent).
  - Ist `nscCharacterId` gesetzt: gleiche Existenz-/Eigentums-/Klassen-Prüfung
    (`class='nsc'`) wie bei `resolveCharacterId`, aber ohne
    "nur einmal registriert"-Regel (NSC bleibt mehrfach nutzbar, unverändert).
  - Rückgabe: `{ nscAvailable: boolean, nscCharacterId: string|null }`.
- `registerForEvent`/`setConRole`: rufen zusätzlich `resolveNscAvailability`
  auf und schreiben `nsc_available`/`nsc_character_id` mit in
  `INSERT`/`UPDATE` und `RETURNING` (→ `nscAvailable`, `nscCharacterId` im
  Response-Objekt).
- `listRegistrationsForUser`, `listParticipantsForEvent`, `getScanLookup`:
  liefern zusätzlich `nscAvailable`/`nscCharacterId` (camelCase) mit aus.

### 5.2 `backend/registrations/routes.js`

- `POST /events/:id/register` und `PUT .../con-role`: lesen zusätzlich
  `body.nscAvailable`/`body.nscCharacterId` und reichen sie durch; neuer
  Error-Code `INVALID_NSC_AVAILABILITY` → `400`.

### 5.3 `backend/characters/repository.js` und `routes.js`

- `SELECT_COLUMNS` ergänzt `is_gsc`.
- `createCharacter`/`updateCharacter`: akzeptieren optional `isGsc` (nur
  wirksam, wenn `characterClass`/`character.class === 'sc'` — bei `nsc` wird
  ein übergebenes `isGsc` ignoriert, nicht validiert, um das Formular schlank
  zu halten).
- `POST /characters`, `PUT /characters/:id`: übernehmen `body.isGsc` in den
  Aufruf.

## 6. Frontend-Änderungen

### 6.1 `frontend/account.html` — Anmeldeformular

- `#con-role-select` (sc/nsc/gsc) wird ersetzt durch:
  - Eine Charakterauswahl `#registration-character-select` mit den eigenen,
    noch nicht anderweitig registrierten SC-Charakteren + Option "Kein
    SC-Charakter".
  - Checkbox `#nsc-available-toggle` "Ich stehe zusätzlich als NSC zur
    Verfügung", die bei Aktivierung ein optionales
    `#registration-nsc-character-select` (eigene NSC-Charaktere + "Kein
    bestimmter Charakter") einblendet.
  - Ein separates Feld für "Wie kommst du?" mit den Werten Charakter / Helfer
    / Orga / Hilfs-Orga bleibt wie heute (`orga`/`hilfs_orga` nur sichtbar für
    Berechtigte) — nur bei "Charakter" ist die obige Charakter-/NSC-Auswahl
    relevant.
  - `POST /events/:id/register` sendet `{ conRole, characterId, nscAvailable,
    nscCharacterId, otFields }`, wobei `conRole` aus "Kein SC + Toggle an" →
    `'nsc'`, sonst `'sc'` (bei "Charakter" gewählt) bzw. helfer/orga/
    hilfs_orga abgeleitet wird.
- `CON_ROLE_LABELS` verliert `gsc`.
- "Meine Anmeldungen"-Tabelle zeigt zusätzlich ein Badge/Hinweis "auch
  NSC-bereit", wenn `nscAvailable` true ist.

### 6.2 `frontend/account.html` — Charakterformular (SC)

- Neue Checkbox "GSC" im SC-Charakterformular (`#character-form`, neben dem
  Namensfeld, nicht Teil der dynamischen `scSchema`-Felder), gebunden an
  `isGsc`. Beim "Aus bestehendem Charakter kopieren"-Flow wird `isGsc` auf
  `false` zurückgesetzt (jede Kopie startet ohne GSC-Flag).
- `tagsForCharacter`: zeigt `GSC` als zusätzlichen Tag, wenn `character.is_gsc`
  true ist.

### 6.3 `frontend/account.html` — NSC-Menü-Sichtbarkeit

- Der NSC-Tab-Button (`nscTabButton`) und der zugehörige Sidebar-Menüpunkt
  sind zusätzlich davon abhängig, ob `currentRegistrations.some(r =>
  r.conRole === 'nsc' || r.nscAvailable)` true ist — nicht mehr nur davon, ob
  `/nsc-schema` erfolgreich geladen werden konnte. Die Sichtbarkeits-Prüfung
  läuft nach `loadRegistrations()`, da sie `currentRegistrations` braucht.

### 6.4 `frontend/admin/checkin.html`

- `CON_ROLE_LABELS` verliert `gsc`. Wo Teilnehmerlisten `con_role` anzeigen,
  wird zusätzlich ein "NSC-bereit"-Hinweis ergänzt, wenn `nscAvailable` true
  ist (Orga sieht so auf einen Blick, wer zusätzlich verfügbar ist).

## 7. Betroffene Tests

- `tests/integration/registrations.test.js`: neue Tests für
  `resolveNscAvailability` (400 bei `nscAvailable`/`nscCharacterId` außerhalb
  `con_role='sc'`, Klassen-/Eigentums-Prüfung, mehrfach nutzbarer
  NSC-Charakter), `nsc`-Registrierung ohne Charakter (jetzt erlaubt), Backfill
  der Migration (bestehende `gsc`-Zeile → `sc` + `characters.is_gsc=true`).
- `tests/integration/characters.test.js`: `isGsc`-Feld bei Erstellung/Update,
  ignoriert bei `class='nsc'`.
- `tests/integration/checkin.test.js`, `scanLookup.test.js`: `nscAvailable`
  taucht in den jeweiligen Response-Shapes auf (bestehende `deepEqual`-Checks
  müssen ergänzt werden).
- Migration selbst: Test analog zu bestehenden Migrations-Tests, der eine
  `gsc`-Zeile vor der Migration einfügt und danach `is_gsc`/`con_role` prüft.
- Frontend: manuell im Browser verifiziert (kein automatisierter
  UI-Interaktionstest in diesem Projekt).

## 8. Rollout-Risiko

Die Migration ändert eine CHECK-Constraint und migriert bestehende
`gsc`-Zeilen — echte Datenmigration, aber additiv (keine Spalte/Zeile wird
gelöscht, nur `con_role`-Werte umgeschrieben und ein neues Flag gesetzt). Wie
bei früheren Con-Rollen-Migrationen: gegen eine Kopie der aktuellen
Dev-Datenbank testen, falls produktive `gsc`-Anmeldungen existieren, bevor
gemerged wird.
