# NSC als Rolle statt Charakterklasse — Implementierungsplan

> Ausführung: Subagent-Driven Development (sonnet, kein `isolation: worktree`), nach jeder Task `git status` im Haupt-Checkout prüfen.
> Ersetzt das Modell aus `2026-10-07-charakter-erstellung-sc-nsc.md` (Tasks 3/4 daraus werden hier teilweise zurückgebaut).

**Neues Modell (User, 2026-10-07):** Charaktere sind erstmal nur Charaktere (= die bisherigen SC-Felder). „NSC" ist keine Charakterklasse mehr, sondern die **Rolle bei der Anmeldung**. Wer einen Charakter als NSC spielen will, wird zusätzlich nach den bisherigen **NSC-Feldern** (Präferenzen, Kämpfe …; vom Admin unter „NSC-Schema" gepflegt) gefragt.

**Entscheidungen:**
- Die NSC-Feldwerte liegen **am Charakter** (`characters.nsc_data`), wiederverwendbar bei jedem Event.
- **Springer** (NSC ohne Charakter) bleibt möglich; ohne Charakter liegen die NSC-Feldwerte an der Anmeldung (`registrations.nsc_data`).
- Bestehende Charaktere der Klasse `nsc` werden normale Charaktere; ihre Daten wandern nach `nsc_data`.
- `characters.class` entfällt komplett. Es gibt nur noch ein „Neuen Charakter anlegen" (kein SC/NSC-Menü mehr).
- `registrations.nsc_wishes` („Springer-Wünsche", erst heute eingebaut) entfällt; die NSC-Felder ersetzen es.
- Der SC-Zusatz „auch als NSC verfügbar" (`nsc_available`, `nsc_character_id`) bleibt unverändert, außer dass `nsc_character_id` keine Klassenprüfung mehr hat.

**Bestand (zum Zurückbauen/Anpassen):** `characters.class` wird u. a. gelesen in `backend/characters/{repository,routes}.js`, `managedPersons/characterRoutes.js`, `groupTree/routes.js`, `accounts/export.js`, `privacy/repository.js`, `members/repository.js`, `registrations/repository.js`, `guestRegistrations/routes.js`, `pdfImport/adopt.js`, `testMode/{load,dataset}.js`, `frontend/account.html`, `managed-person.html`, `admin/{checkin,members,groups}.html`, `widget.js`, `js/createMenu.js`.

---

## Task 1: Migration + Charakter-Backend

**Dateien:** neue `db/migrations/096_nsc_als_rolle.sql`, `backend/characters/{repository,routes,visibility}.js`, `backend/managedPersons/characterRoutes.js`, `tests/integration/characters*.test.js`, `tests/integration/migrate.test.js` (nur falls nötig)

- Migration (nächste freie Nummer prüfen): `characters.nsc_data jsonb NOT NULL DEFAULT '{}'`, `registrations.nsc_data jsonb NOT NULL DEFAULT '{}'`; `UPDATE characters SET nsc_data = data, data = '{}' WHERE class = 'nsc'`; Anmeldungen, die einen ehemaligen NSC-Charakter als `character_id` hatten, bleiben gültig (Charakter existiert weiter); `ALTER TABLE characters DROP COLUMN class` (zugehörige Constraints/Indizes vorher prüfen); `ALTER TABLE registrations DROP COLUMN nsc_wishes`.
- `createCharacter`/`updateCharacter`: kein `characterClass` mehr, Schema immer SC. `POST /characters` ignoriert/verwirft `class` (400 bei `class` ≠ undefined ist unnötig — ignorieren).
- Neuer Endpunkt `PUT /characters/:id/nsc-data` (Besitzer, oder Admin/Moderator-Regeln wie beim Charakter-Update inkl. `staffOnly`-Felder und Audit-Log): validiert gegen `getNscProfileSchema()`. Gemeinsame Logik mit dem bestehenden Update (staffOnly, groupManaged) wiederverwenden, nicht kopieren.
- `GET /characters` liefert `nscData`; Sichtbarkeit: `nsc_data` nur Besitzer/Elevated (nie öffentlich, nicht in `filterCharacterFields`/Charakter-Browsing).
- Tests: Charakter anlegen ignoriert `class`; `PUT nsc-data` Validierung/Rechte; Migration wandelt einen Alt-NSC-Charakter korrekt um (Test mit manuell angelegter Zeile vor Migration ist schwer — dafür SQL-Funktionstest oder manuelle Prüfung dokumentieren).

## Task 2: Anmelde-Backend

**Dateien:** `backend/registrations/{repository,routes}.js`, `backend/managedPersons/registrationRoutes.js`, `backend/members/repository.js`, `tests/integration/registrations.test.js`, `tests/integration/checkin.test.js`

- Entfernen: `nscWishes` (Repository, Routen, Tests), Klassenprüfung in `resolveCharacterId`/`resolveNscAvailability` (jetzt nur noch „gehört dem Nutzer"; „höchstens eine SC-Anmeldung pro Charakter" bleibt für Rolle `sc`; `nsc_character_id !== character_id` bleibt).
- Neu: Parameter `nscData` bei Registrieren/Rolle ändern (nur bei `conRole === 'nsc'`, sonst verwerfen). Gegen NSC-Schema validieren (`sanitizeDocumentFields` + `validateCharacterData`, gleiche `INVALID_CHARACTER_DATA`-Behandlung wie beim Charakter). Mit Charakter → in `characters.nsc_data` schreiben (Besitzer-Check, `staffOnly`-Felder unangetastet); ohne Charakter → `registrations.nsc_data`. Beim Wechsel von NSC auf eine andere Rolle bleibt der Charakter-Datensatz erhalten, `registrations.nsc_data` wird geleert.
- Ausgabe: `nscData` in eigenen Anmeldungen und Orga-Teilnehmerliste/Mitglieder-Detail (effektiv: Charakter-`nsc_data`, sonst Anmeldung). Orga-Auswahlliste (`selectableCharacters`): alle freien eigenen Charaktere für beide Rollen, ohne `class`.
- Orga-Rollendialog (`PUT con-role`) kann `nscData` mitschicken.
- Tests: NSC mit Charakter schreibt `nsc_data` an den Charakter; Springer schreibt an die Anmeldung; ungültige Felder → 400; Rollenwechsel nsc→sc leert Anmeldungs-`nsc_data`; SC-Anmeldung ignoriert `nscData`.

## Task 3: Weitere Backend-Stellen

**Dateien:** `backend/groupTree/routes.js`, `backend/accounts/export.js`, `backend/privacy/repository.js`, `backend/guestRegistrations/routes.js`, `backend/pdfImport/adopt.js`, `backend/testMode/{load,dataset}.js` und deren Tests

- `groupTree`: `groupManaged`-Felder aus SC- **und** NSC-Schema, NSC-Felder gegen `nsc_data` (Struktur der Antwort so anpassen, dass das Frontend sie als eigenen Abschnitt „NSC-Profil" pro Charakter bekommt — Frontend-Anpassung in Task 5).
- `accounts/export.js`: NSC-Felder als eigener Abschnitt je Charakter bzw. Anmeldung.
- `privacy`: `wipeCharacterFields(…, 'nsc', …)` löscht die NSC-Schlüssel jetzt in `characters.nsc_data` (der Charaktere der Anmeldungen des Events) und `registrations.nsc_data` des Events; `sc`-Scope bleibt auf `characters.data`.
- Gastanmeldung: `character`-Erzeugung nur noch SC; bei NSC werden die ausgefüllten NSC-Felder als `nscData` an `registerForEvent` gegeben (kein NSC-Charakter mehr anlegen). `nscFields` im Event-Endpunkt bleibt.
- `pdfImport/adopt.js` und `testMode`: `characterClass` entfernen; testMode-Datensatz setzt NSC-Daten am Charakter/der Anmeldung.

## Task 4: Frontend — Charakter-Verwaltung zurückbauen

**Dateien:** `frontend/account.html`, `frontend/managed-person.html`, `frontend/js/createMenu.js` (löschen), `frontend/css/sahara.css`

- SC/NSC-Menü und alle NSC-Charakter-Tabs/-Formulare/-Listen/-Dateipanels/-Create-Cards entfernen; zurück zu einer Karte „Neuen Charakter anlegen" (Dashboard + Charakterseite) mit dem bisherigen SC-Formular. Keine toten IDs/Handler/CSS zurücklassen (`createMenu.js`, `.create-menu-*`, `nsc-*`-Elemente, `updateNscMenuVisibility`, `nscSchema`-Laden fürs Charakterformular).
- `class`-Verwendungen im Frontend entfernen (Filter `c.class !== "nsc"` usw.).
- Gruppenverwalter-Ansicht (`groupTree`-Felder): NSC-Abschnitt pro Charakter darstellen, falls die API jetzt welche liefert.

## Task 5: Frontend — NSC-Anmeldung mit NSC-Feldern

**Dateien:** `frontend/account.html`, `frontend/managed-person.html`, `frontend/admin/{checkin,members}.html`, `frontend/widget.js`

- NSC-Panel: Frage „Mit welchem Charakter spielst du?" (Select: „Kein Charakter – ich komme als Springer" + alle eigenen Charaktere, Karte „Neuen Charakter anlegen" bleibt). Darunter der **NSC-Fragebogen** (alle NSC-Schema-Felder, wie bisher gerendert, `renderField` mit Präfix `nsc-`), vorbelegt aus dem Charakter (`nscData`) bzw. der Anmeldung; Wechsel der Charakter-Auswahl lädt die Werte des anderen Charakters. Beim Absenden als `nscData` mitgeben. Textarea „Springer-Wünsche" entfernen.
- Orga: `checkin.html`-Rollendialog und `members.html`-Detail zeigen/bearbeiten die NSC-Felder (statt Wünsche); `staffOnly`-Felder nur für Berechtigte editierbar (wie bei Charakterfeldern).
- `widget.js`: NSC-Fragebogen schickt `nscData` statt `character.data` (Gast-Wizard, Rolle NSC); SC unverändert.
- Im Browser prüfen: Charakter ohne Anmeldung anlegen; NSC mit Charakter (Felder speichern, bei zweitem Event vorbelegt); Springer; Orga sieht/ändert Felder; Gastwizard NSC.

## Task 6: Abschluss

- Alte Tests anpassen (`class`, `nscWishes`, NSC-Charakter-Tests in `characters.test.js`/`registrations.test.js`/`nscSchema.test.js`/`privacyDeletion.test.js`/`testMode.test.js` …), **volle Testsuite** (`DATABASE_URL=postgres://app:app@localhost:5433/pakyrion_test npm test`).
- Version: für heute ist schon ein Bump erfolgt → keiner nötig, sonst Regel aus CLAUDE.md.
- Altplan `2026-10-07-charakter-erstellung-sc-nsc.md` oben mit „teilweise überholt durch nsc-als-rolle" markieren.
- Commit + Push (nur eigene Dateien).

## Risiken / offen

- `characters.class` ist breit verteilt; nach Task 1–3 per `grep -rn "\.class\b\|characterClass\|class: 'nsc'"` auf Reste prüfen.
- Daten gehen bei der Umwandlung nicht verloren (`data` → `nsc_data`), `nsc_wishes` wird verworfen.
- Bestehende NSC-Anmeldungen mit Alt-NSC-Charakter behalten ihren Charakter; dessen Name bleibt, SC-Felder sind leer (er ist jetzt ein normaler, unvollständiger Charakter — das „Pflichtfeld"-Problem tritt erst beim Bearbeiten auf).
- SC-Zusatz „auch NSC verfügbar" fragt weiterhin keine NSC-Felder ab (nicht Teil dieses Plans).
