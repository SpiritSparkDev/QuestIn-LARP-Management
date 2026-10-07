# Charaktererstellung SC/NSC zusammenlegen — Implementierungsplan

> Ausführung: Subagent-Driven Development (sonnet, kein `isolation: worktree`), nach jeder Task `git status` im Haupt-Checkout prüfen.

**Anlass:** Feedback (Malphas/Holzeule, 2026-10-07): NSC-Charaktere lassen sich nur über den Anmeldeprozess anlegen, SC-Charaktere auch ohne Anmeldung. Das ist unintuitiv.

**Beschlossene Regeln (aus dem Feedback):**
1. Ein Einstieg „Neuen Charakter anlegen" mit Auswahl **SC / NSC** (Dashboard und Charakter-Seite), unabhängig von einer Anmeldung.
2. Bei der NSC-Anmeldung wird gefragt, ob man einen **festen NSC** spielt (eigener NSC-Charakter) oder nicht (= Springer).
3. **Springer-Wünsche** kann man immer angeben, auch mit festem NSC.
4. **Wiederverwendung nur in eine Richtung:** SC-Charaktere können als SC *und* als NSC mitkommen; NSC-Charaktere nie als SC.

**Bestand (nicht neu bauen):**
- `characters.class` ('sc'|'nsc'); `POST /characters` akzeptiert beide ([backend/characters/routes.js:18](backend/characters/routes.js)).
- NSC-Anmeldung hat schon einen optionalen Charakter (`CHARACTER_OPTIONAL_CON_ROLES = ['nsc']`, [backend/registrations/repository.js:28](backend/registrations/repository.js)).
- Die NSC-Tab/-Sektion ist nur sichtbar, wenn man NSC-Rolle gewählt hat oder eine NSC-Anmeldung hat: `updateNscMenuVisibility()` in [frontend/account.html](frontend/account.html) (~Z. 2604) und [frontend/managed-person.html:499](frontend/managed-person.html). **Das ist die eigentliche Ursache des Problems.**

**Nicht Teil dieses Plans:** der volle NSC-Dialog (Orga antwortet mit Rollenvorschlägen) — bleibt eigenes Feature (Roadmap). Hier nur das Freitextfeld „Springer-Wünsche".

---

## Task 1: Backend — SC-Charaktere als NSC erlaubt

**Dateien:** `backend/registrations/repository.js`, `tests/integration/registrations.test.js`

- `resolveCharacterId`: für `conRole === 'nsc'` Klasse `sc` **und** `nsc` akzeptieren; für `sc` weiter nur `sc`. Der „höchstens eine Anmeldung"-Check (`CHARACTER_ALREADY_REGISTERED`) bleibt nur für die Rolle `sc`, d. h. ein SC-Charakter darf als NSC in beliebig vielen Events mitkommen. Kommentar am Funktionskopf anpassen.
- `resolveNscAvailability`: `nscCharacterId` darf Klasse `sc` oder `nsc` sein; muss dem Nutzer gehören; darf nicht der `character_id` der Anmeldung selbst sein (neuer Fehlercode `INVALID_NSC_AVAILABILITY`). Dafür `characterId` als Parameter durchreichen (Aufrufer: `registerForEvent`, `setConRole`).
- Orga-Auswahlliste (~Z. 662, „selectable characters"): für Rolle NSC auch freie SC-Charaktere des Nutzers anbieten. Prüfen, wie `selectableByUser` im Frontend (`members.html`) genutzt wird, und die Klasse mitgeben (`class` ist schon im Objekt).
- Tests (rot zuerst): NSC-Anmeldung mit SC-Charakter ok; NSC-Anmeldung mit SC-Charakter, der schon SC-angemeldet ist, ok; SC-Anmeldung mit NSC-Charakter → `CHARACTER_CLASS_MISMATCH`; `nscCharacterId === characterId` → Fehler.

## Task 2: Backend — Springer-Wünsche

**Dateien:** neue `db/migrations/095_registration_nsc_wishes.sql`, `backend/registrations/repository.js`, `backend/registrations/routes.js`, `tests/integration/registrations.test.js`

- Migration: `ALTER TABLE registrations ADD COLUMN nsc_wishes text;` (nullable).
- `registerForEvent` / `setConRole` / Update-Pfad: Feld `nscWishes` (String, auf z. B. 2000 Zeichen kürzen/ablehnen) nur bei `conRole === 'nsc'` speichern, sonst `NULL`. In den SELECTs der eigenen Anmeldungen (~Z. 796) und der Orga-Detailansicht (~Z. 636/705) als `nscWishes` ausgeben.
- Routen: `nscWishes` aus dem Body durchreichen (Register + Rolle ändern).
- Test: speichern, ausgeben, bei SC-Rolle verworfen. Migrationstest (`migrate.test.js`) läuft mit.

## Task 3: Frontend — ein Einstieg „Neuen Charakter anlegen"

**Dateien:** `frontend/account.html`, `frontend/managed-person.html`

- `updateNscMenuVisibility()`: Sichtbarkeit nur noch von `nscSchemaAvailable` abhängig machen (nicht von Rolle/Anmeldung). Gleiches in `managed-person.html` (`~Z. 499`). Der Aufruf bei Rollenwechsel wird dadurch harmlos, kann bleiben oder entfallen.
- Dashboard-Karte „Neuen Charakter anlegen" (`#dashboard-new-character-btn`): Klick öffnet ein kleines Menü/Dropdown mit „Spielercharakter (SC)" und „Nichtspielercharakter (NSC)". SC → bisheriges Verhalten (`goToTab("charaktere")` + `newCharacterBtn.click()`); NSC → `goToTab("charaktere")`, `#nsc-tab-btn.click()`, `#new-nsc-character-btn.click()`. Menü nur zeigen, wenn NSC-Schema verfügbar, sonst direkt SC.
- Charakter-Seite: die zwei Create-Cards (`#new-character-btn`, `#new-nsc-character-btn`) zu **einer** Karte mit demselben Menü zusammenlegen (über beiden Tabs/Listen sichtbar). Die Tabs „Charaktere" / „NSC-Charaktere" bleiben als getrennte Listen/Formulare, weil die Schemas verschieden sind.
- Menü als natives `<details>`/Popover oder kleines `<dialog>`-freies Dropdown; Styling an vorhandene `create-card`-Klassen anlehnen. Tastatur-bedienbar (Pfeile/Enter, Escape schließt).
- Texte der NSC-Karte anpassen: „Lege eine Figur an, die du als Nichtspielercharakter darstellen kannst – auch ohne Anmeldung."

## Task 4: Frontend — NSC-Anmeldung: fester NSC / Springer + Wünsche

**Dateien:** `frontend/account.html` (`#nsc-role-panel`, Submit-Handler ~Z. 2332), `frontend/managed-person.html` (`#nsc-role-panel`), `frontend/widget.js` falls dort eine NSC-Rollenwahl mit Charakter existiert (nur prüfen, Gastanmeldung unverändert lassen, wenn sie keinen Charakter auswählt)

- Panel umbauen: Überschrift „Spielst du einen festen NSC?" mit Select (Option 1: „Nein – ich komme als Springer", weitere: eigene Charaktere) und der Karte „Neuen NSC-Charakter anlegen". Der Select listet **alle eigenen Charaktere** (NSC zuerst, dann SC, mit Zusatz „(SC)"), nicht mehr nur Klasse `nsc`.
- Darunter immer sichtbar (bei NSC-Rolle) Textarea „Springer-Wünsche (optional)": „Welche Rollen/Einsätze liegen dir, was lieber nicht?" → als `nscWishes` im Submit mitsenden, beim Bearbeiten der Anmeldung vorbelegen.
- Hinweis-Link `#no-nsc-character-hint-btn` bleibt (springt zum NSC-Tab bzw. öffnet das NSC-Formular).
- Orga-Sicht (`frontend/admin/members.html`, Detail zur Anmeldung): `nscWishes` und gewählten Charakter anzeigen; die Charakterauswahl der Orga bietet ebenfalls SC+NSC (aus Task 1).
- Anmeldebestätigung/Mail: nur anpassen, falls dort der NSC-Charakter ausgegeben wird (grep `nscCharacterName`).

## Task 5: Abschluss

- Version: `feat` → MINOR-Bump nach CLAUDE.md-Regel (`git log --since=midnight` prüfen; `frontend/js/version.js`, `package.json`, `package-lock.json` synchron).
- **Volle Testsuite** laufen lassen (nicht nur gescopte Teilmengen), siehe `docker-compose.dev.yml`.
- Manuell im Dev-Stack prüfen: (a) Konto ohne Anmeldung → Dropdown → NSC-Charakter anlegen; (b) SC-Charakter als NSC anmelden; (c) NSC-Charakter bei SC-Anmeldung nicht wählbar; (d) Springer-Wünsche speichern/ändern; (e) Gruppenverwalter-Seite (`managed-person.html`) gleiches Verhalten.
- Commit + Push (nur eigene Dateien stagen).

## Risiken / offen

- Bestehende NSC-Anmeldungen haben `nsc_wishes = NULL` — kein Backfill nötig.
- SC-Charakter als NSC: Sichtbarkeit/Charakter-Browsing ändert sich nicht (`listCharactersForEvent` zeigt weiter nur SC-Anmeldungen).
- Löschen eines SC-Charakters, der irgendwo als NSC hinterlegt ist: `deleteCharacter` löst die `nsc_character_id`-Verknüpfung schon (`UPDATE … SET nsc_character_id = NULL`), die Anmeldung als NSC bleibt bestehen; für `character_id` der NSC-Rolle ebenfalls prüfen (Task-1-Test ergänzen: Löschen bei NSC-Anmeldung mit SC-Charakter).
- Offene Abstimmung mit Malphas („erstmal bilateral"): Die Punkte 2–4 sind so umgesetzt, wie sie im Chat stehen; falls sich daran noch etwas ändert, betrifft das nur Task 4.
