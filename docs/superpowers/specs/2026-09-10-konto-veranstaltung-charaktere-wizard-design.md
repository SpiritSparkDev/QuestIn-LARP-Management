# Konto/Veranstaltung/Charaktere-Wizard — Design Spec

## 1. Problem

Charaktererstellung und Event-Anmeldung sind heute auf drei getrennte
Nav-Seiten verteilt (`account.html`, `characters.html`,
`con-anmeldungen.html`), die für sich stehen. Der eigentliche
Nutzerfluss — OT-Daten hinterlegen, Event aussuchen, dafür einen
Charakter anlegen oder wählen — ist über drei Seitenwechsel verstreut.
Wer beim Anmelden keinen passenden Charakter hat, verlässt den
Anmelde-Kontext komplett (Link zu `characters.html`) und muss danach
selbst zurückfinden.

## 2. Ziel

Eine Seite (`frontend/account.html`) mit zwei Ebenen von Tabs bildet
den kompletten Fluss ab:

- **Konto** — heutiges OT-Formular + QR-Code, unverändert.
- **Veranstaltung** — Unterschritte:
  - **Anmelden** — heutiger Inhalt von `con-anmeldungen.html`: Event
    wählen, Rolle wählen, Charakter wählen, event-spezifische Felder,
    anmelden, bestehende Anmeldungen verwalten.
  - **Charaktere** — heutiger Inhalt von `characters.html`: eigene
    Charaktere anlegen/bearbeiten (SC + NSC-Unterschritte, Datei-Upload),
    unverändert in der Funktionalität, nur als verschachtelter Tab
    statt eigener Seite.

Der "kein passender Charakter"-Hinweis im Anmelden-Schritt wechselt auf
den Charaktere-Unterschritt statt auf eine fremde Seite zu verlinken.

Nav-Menü zeigt dafür nur noch einen Eintrag ("Konto"), der zur neuen
Seite führt.

## 3. Nicht-Ziel

- Keine Änderung an Backend-APIs (`/account`, `/characters`,
  `/events`, `/registrations`, `/nsc-schema`, Datei-Upload-Routen) —
  reiner Frontend-Umbau plus einer Menü-Schlüssel-Migration (Abschnitt
  4).
- Keine Änderung an der Charakter/Con-Anmeldung-Datenmodell-Logik
  (bereits entkoppelt, siehe
  `docs/superpowers/specs/2026-09-08-charakter-con-anmeldung-entkoppeln-design.md`).
- Kein Deep-Linking auf einzelne Tabs per URL-Hash — reiner
  Client-State, Seite lädt immer auf Konto-Tab.
- `characters-browse.html` (Charaktere anderer Spieler durchsuchen)
  bleibt eigenständig, nur der Rücklink ändert sich.

## 4. Menü-Schlüssel-Konsolidierung

Heute sind `konto`, `charaktere`, `con-anmeldungen` drei unabhängig
togglebare Menü-Rechte pro Gruppe (`groups.visible_menus`, editierbar
in `admin/groups.html`). Da die drei Bereiche jetzt eine einzige Seite
sind, ist getrennte Sichtbarkeit sinnlos — es gibt nur noch einen
Menüpunkt.

- `backend/groups/routes.js`: `MENU_KEYS` verliert `'charaktere'` und
  `'con-anmeldungen'`, bleibt `['konto', 'mitglieder', 'events',
  'checkin']`.
- `db/groupDefaults.js`: alle `visibleMenus`-Arrays verlieren
  `'charaktere'`/`'con-anmeldungen'` (der `'konto'`-Eintrag bleibt —
  jede bestehende Gruppe, die heute `charaktere` oder
  `con-anmeldungen` sieht, hat auch `konto`, siehe Grep-Befund unten,
  also kein Gruppen verliert dadurch Zugriff).
- Neue Migration (`db/migrations/031_...sql`): für alle Zeilen in
  `groups` `visible_menus` auf `visible_menus - 'charaktere' -
  'con-anmeldungen'` setzen (jsonb `-` Operator entfernt ein Element).
  Kein Rollback-Risiko — Menüpunkte werden nur entfernt, `konto` bleibt
  überall stehen.
- `frontend/admin/groups.html`: die beiden Checkboxen für
  `charaktere`/`con-anmeldungen` (Zeilen 50–51) entfernt.

**Verifiziert:** alle 3 aktuell in `db/groupDefaults.js` geseedeten
Gruppen (`admin`, `moderator`, `mitglied`), die `charaktere` oder
`con-anmeldungen` führen, führen auch `konto`. Für individuell in
Produktion angelegte/bearbeitete Gruppen gilt das nicht automatisch —
Rollout-Hinweis in Abschnitt 8.

## 5. `frontend/js/nav.js`

```js
const MENU_LINKS = [
  { key: 'konto', label: 'Konto', href: '/account.html' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html' },
  { key: 'events', label: 'Events', href: '/admin/events.html' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html' },
];
```

Die Einträge für `charaktere` und `con-anmeldungen` entfallen.

## 6. `frontend/account.html` — Struktur

Top-Level-Tabs (analog zum bestehenden `.tabs`/`.tab-btn`/`.tab-panel`-
Muster aus `characters.html`):

```
<div class="tabs" id="main-tabs">
  <button data-tab="konto-tab" class="active">Konto</button>
  <button data-tab="veranstaltung-tab">Veranstaltung</button>
</div>

<div class="tab-panel" id="konto-tab">
  <!-- heutiger #account-form + #qr-section, 1:1 aus account.html -->
</div>

<div class="tab-panel" id="veranstaltung-tab" hidden>
  <div class="tabs tabs--sub" id="veranstaltung-tabs">
    <button data-tab="anmelden-subtab" class="active">Anmelden</button>
    <button data-tab="charaktere-subtab">Charaktere</button>
  </div>

  <div class="tab-panel" id="anmelden-subtab">
    <!-- heutiger Inhalt von con-anmeldungen.html: #registration-list,
         edit-ot-dialog, #registration-form -->
  </div>

  <div class="tab-panel" id="charaktere-subtab" hidden>
    <!-- heutiger Inhalt von characters.html: #main-tabs (SC/NSC),
         umbenannt um Kollision mit dem neuen äußeren #main-tabs zu
         vermeiden (z.B. #char-tabs) -->
  </div>
</div>
```

`initTabs()` (bereits vorhanden in `characters.html`) wird generisch
genug wiederverwendet für alle drei Tab-Ebenen (äußere Konto/
Veranstaltung, Anmelden/Charaktere, und die bestehende SC/NSC- sowie
NSC-Formular-Ebene) — ein Aufruf pro `.tabs`-Container.

**Script-Merge:** Die drei `<script type="module">`-Blöcke aus
`account.html`, `con-anmeldungen.html`, `characters.html` werden zu
einem zusammengeführt. Jeder Block behält seine DOM-Referenzen,
Funktionen und Event-Listener unverändert — es gibt keine
Namenskollisionen bei Bezeichnern wie `message`, `form`, da jede Seite
heute eigene, spezifische IDs nutzt (`account-form`/`message` in
Konto-Teil kollidiert mit `message` in den anderen beiden Teilen: die
drei `<p id="message">`-Elemente bekommen eindeutige IDs, z.B.
`account-message`, `registration-message`, `character-message`, und
die zugehörigen `document.getElementById('message')`-Aufrufe werden
entsprechend angepasst).

**Ein gemeinsamer Ladepfad:** Statt dreier separater
`api.get('/account')`-Aufrufe (einer pro alter Seite) lädt die neue
Seite `/account` genau einmal beim Start, rendert `nav-links`, und
alle drei Tab-Bereiche greifen auf dasselbe `account`-Objekt zu (heute
schon strukturell identisch: jede der drei Seiten macht denselben aus
`try { const account = await api.get('/account'); ... } catch...`
Boilerplate-Block am Skriptende — wird zu einem gemeinsamen Block, der
`loadAccountTab(account)`, `loadVeranstaltungTab(account)` und
`loadCharaktereTab(account)` aufruft).

**Logout-Button:** nur einmal im Markup (nicht dreimal), ein
Event-Listener.

**"Kein passender Charakter"-Hinweis:** statt `<a
href="/characters.html">Charakter anlegen</a>` wird ein `<button
type="button">` daraus, das auf Klick den Charaktere-Unterschritt
aktiviert (`veranstaltungTabs` → `charaktere-subtab`).

## 7. `frontend/characters-browse.html`

Zeile 20: Rücklink ändert sich von `/characters.html` auf
`/account.html`, Linktext bleibt sinngemäß ("Zurück zu meinen
Charakteren").

## 8. Gelöschte Dateien

`frontend/characters.html`, `frontend/con-anmeldungen.html` — keine
Redirect-Stubs, da die einzigen Verweise darauf (`nav.js`, der
Hint-Link in `con-anmeldungen.html`, der Rücklink in
`characters-browse.html`) alle Teil dieses Umbaus sind und mit
aktualisiert werden. Es gibt keine extern verlinkten/gebookmarkten
Pfade außerhalb der App selbst (kein Verweis in E-Mail-Templates o.ä.
— verifiziert per Grep über `backend/` auf diese beiden Dateinamen:
keine Treffer).

## 9. Betroffene Tests

Keine Backend-API ändert sich, daher keine Integrationstests für
Characters/Registrations/Events betroffen. Einzig
`tests/integration/seedGroups.test.js` und
`tests/integration/groups.test.js` berühren `visible_menus` — beide
lesen Erwartungswerte aus `db/groupDefaults.js` bzw. übergeben eigene
Arrays (`['konto', 'checkin']`), keine harten Referenzen auf
`charaktere`/`con-anmeldungen`-Strings, die nach der Migration
fehlschlagen würden. Kein Frontend-Test-Setup vorhanden (keine
Tests unter `tests/` referenzieren `.html`-Dateien) — Verifikation der
UI erfolgt manuell im Browser gegen den Dev-Server.

## 10. Rollout-Risiko

- **Migration 030** entfernt nur Array-Elemente aus `visible_menus`,
  kein Datenverlust, keine Sperre. Einziges Risiko: eine in Produktion
  individuell angelegte Gruppe, die `charaktere`/`con-anmeldungen`
  aber NICHT `konto` sichtbar hat, verliert dadurch den einzigen Zugriff
  auf diesen Bereich (Abschnitt 4). Vor dem Merge: aktuelle
  Produktions-`visible_menus` aller Gruppen prüfen (`SELECT key,
  visible_menus FROM groups`), falls eine solche Gruppe existiert,
  vor der Migration `konto` manuell ergänzen.
- Statische Datei-Löschung (`characters.html`,
  `con-anmeldungen.html`) — nach Deploy sind alte Bookmarks/offene Tabs
  auf diese Pfade 404. Kein serverseitiges Redirect vorgesehen (YAGNI,
  kleine Nutzerbasis, Nav-Link ist der einzige reguläre Zugriffsweg).
