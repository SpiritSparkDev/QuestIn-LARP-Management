# UI-Verbesserungen — Design

**Status:** Approved by user 2026-09-02, ready for plan decomposition.

## Kontext

Ausgangsspec: `docs/superpowers/specs/2026-09-01-ui-improvemend.md` (User-verfasst, unstrukturierte Feature-Wunschliste über zwei Bereiche: Konto/Charaktere und Mitglieder-Verwaltung, plus allgemeine UX-Empfehlungen). Während der Klärung stellte sich heraus:

1. Die Spec nennt Font-Awesome, ein CSS-Modal-Framework und eine JS-Validierungs-Bibliothek als Abhängigkeiten — das widerspricht dem Projekt-Prinzip "kein Build-Step, keine neuen Abhängigkeiten, native Plattform-Features zuerst", das in jedem bisherigen Plan dieser Session konsequent durchgehalten wurde (natives `<dialog>` für Modals, HTML5-Validierung, CDN-Fonts wie Google Fonts statt npm-Pakete). Nutzer hat sich für die komplett native Variante entschieden.
2. "Charaktere in Mitglied bearbeiten editieren" klingt nach reiner UI-Arbeit, erfordert aber drei echte Backend-Erweiterungen (siehe Teil 3) — deutlich mehr Tragweite als der Rest der Spec, deshalb ein eigener Plan mit entsprechender Review-Tiefe.
3. Die von der Spec behauptete Rechtschreibkorrektur "Verschüsselt" → "Verschlüsselt" ist bereits erledigt (überall korrekt geschrieben) — kein Fix nötig, nur das Icon+Tooltip ist neu.
4. "Reihenfolge durch Drag-and-Drop änderbar" (Charaktere) wurde explizit zurückgestellt — kein Ordnungskonzept existiert aktuell im Datenmodell, deutlich aufwändiger als der Rest der Spec und nicht Teil dieser Iteration.

**Reihenfolge (jeder Teil ein eigener Plan):** 1 → 2 → 3. Teile sind voneinander unabhängig (keine echte Abhängigkeit zwischen ihnen), Reihenfolge nur nach Risiko/Aufwand sortiert (kleinstes zuerst).

---

## Teil 1: Konto & Charaktere UI-Verbesserungen

### 1.1 Icons: Material Symbols statt Font-Awesome
`<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" rel="stylesheet">` — exakt dasselbe Muster wie die bereits in jeder Seite eingebundenen Google Fonts (kein neues Script, keine neue npm-Abhängigkeit, nur eine zusätzliche Stylesheet-Zeile pro betroffener Seite). Verwendung: `<span class="material-symbols-outlined">icon_name</span>`. Konsistente Größen über eine neue CSS-Regel (`.material-symbols-outlined{ font-size:20px; vertical-align:middle; }`, mit einer `--icon-size-lg`-Variante für größere Kontexte), Hover-Skalierung über eine `transition:transform` + `:hover{ transform:scale(1.15); }`-Regel auf interaktiven Icon-Buttons.

Icons für: Logout (`logout`), Verschlüsselungs-Hinweis (`lock`), sowie an den Stellen, wo Teil 3 später Edit/Delete/Add-Icons für Charaktere braucht (`edit`, `delete`, `add`) — dieser Teil richtet nur das Icon-System ein und wendet es auf die hier beschriebenen Konto/Charaktere-Stellen an; Teil 3 nutzt dieselbe Klasse ohne erneute Einrichtung.

### 1.2 Logout-Button redesignen
Auf `account.html` und `characters.html` (den beiden Seiten mit dem aktuellen `<a href="#" id="logout-link">Logout</a>`-Muster): `<button>` statt `<a>`, positioniert oben rechts in der `.folio`/`.shell`-Struktur (neue CSS-Regel, `position:absolute` relativ zum bestehenden `.shell`-Container oder ein Flexbox-Umbau des Brand-Headers — Details bei der Plan-Erstellung anhand des tatsächlichen aktuellen Markups entschieden), rotes/warnendes Styling (neue `.btn-danger`-artige Klasse, passend zum bereits existierenden `--error`-CSS-Custom-Property), mit Logout-Icon. Bestätigung: nativer `confirm('Wirklich abmelden?')` vor dem eigentlichen Logout-Request (kein neues Dialog-Element nötig für einen einzelnen Ja/Nein-Schritt, konsistent mit anderen "Bist du sicher?"-Stellen im Projekt, die bereits `confirm()` verwenden — z.B. `admin/checkin.html`s Status-Override). Mobile: kleinere Schriftgröße/Padding über eine bestehende Breakpoint-Konvention (falls noch keine existiert, wird eine einfache `@media (max-width: 600px)`-Regel ergänzt).

`admin/*.html`-Seiten haben bereits ein separates, funktionierendes Logout-Muster (`.sidebar-foot`) im anderen Theme (`everest-registry.css`) — bleibt unverändert, die Spec bezieht sich explizit auf den Bereich "Konto und Charaktere" (Teilnehmer-Theme `chronicle-crest.css`).

### 1.3 Verschlüsselungs-Hinweis mit Icon
Jedes bestehende `<span class="sealed">Verschlüsselt</span>` (7 Stellen in `account.html`, plus die entsprechenden Stellen in `admin/members.html`s Mitglied-Detail-Ansicht, siehe `ACCOUNT_FIELD_LABELS`) bekommt ein vorangestelltes Schloss-Icon (`<span class="material-symbols-outlined" aria-hidden="true">lock</span>`) und einen erklärenden `title`-Tooltip (natives HTML-Attribut, kein JS/CSS-Tooltip-Mechanismus nötig) — `title="Dieses Feld ist verschlüsselt gespeichert"` auf dem `.sealed`-Element selbst. Icon-Farbe grün oder blau über die bestehende `--primary`/`--success`-Custom-Property (welche genau, wird beim Implementieren anhand des tatsächlichen Farbkontrasts entschieden). Erscheint ausschließlich auf tatsächlich verschlüsselten Feldern — das ist bereits der Fall, da `.sealed` nur dort im Markup steht.

### 1.4 Eingabefelder-Layout: responsives Grid
`account.html`s Formular (aktuell eine einfache vertikale Abfolge von Label/Input-Paaren) bekommt ein CSS-Grid-Layout: 1 Spalte auf Mobile (`@media (max-width: 768px)`), 2 Spalten auf Desktop. Logische Gruppierung (Name-Felder Vorname/Nachname/Rufname zusammen, Notfallkontakt-Felder zusammen) über `<fieldset>`-Elemente oder Grid-Bereiche — Details bei Plan-Erstellung. Label-Platzierung (unterhalb des Feldes) ist bereits durch einen früheren Plan (`2026-08-30-16-ui-kleinigkeiten.md`) umgesetzt, hier nur konsistente Abstände über die Grid-`gap`-Eigenschaft.

### 1.5 Client-seitige Validierung
Native HTML5-Validierung: bestehende `required`-Attribute bleiben, `type="email"`/`type="tel"`-artige Constraints wo sinnvoll (z.B. `phone`-Feld bekommt kein striktes `pattern`, da internationale Telefonnummern-Formate zu variabel sind — nur `required` wo zutreffend). Echtzeit-Feedback: ein neuer, wiederverwendbarer Helper `attachLiveValidation(formEl)` in `frontend/js/formFields.js` — hört auf `input`/`blur`, setzt eine `.invalid`-CSS-Klasse (rote Border) und zeigt `element.validationMessage` in einem kleinen `<p class="field-error">`-Element direkt unter dem Feld, sobald `!element.checkValidity()` nach der ersten Interaktion. Pflichtfelder-Kennzeichnung: ein `*` nach dem Label-Text für jedes `required`-Feld, per CSS (`label:has(+ [required])::after{ content:" *"; }` — moderne `:has()`-Unterstützung ist in allen aktuellen Browsern vorhanden, kein JS nötig) oder alternativ direkt im Markup, je nachdem was beim Implementieren robuster ist.

---

## Teil 2: Mitglieder-Verwaltung — Modal-Dialoge

### 2.1 "Mitglied einladen" als Pop-Out
`admin/members.html`s bestehendes inline `#invite-form` (aktuell dauerhaft sichtbar in einer eigenen Karte unter der Mitgliederliste) wandert in ein natives `<dialog id="invite-dialog">`, geöffnet über einen neuen "+ Mitglied einladen"-Button oberhalb der Mitgliederliste (`.showModal()`), geschlossen über ein X-Icon oben rechts im Dialog UND den bestehenden Erfolgspfad (`.close()` nach erfolgreichem Senden). Gleiches Muster wie `admin/groups.html`s bereits bestehendes Gruppen-Dialog (aus `2026-08-30-16-ui-kleinigkeiten.md`) — dieser Plan repliziert ein bereits bewährtes Muster, keine neue Technik.

### 2.2 "Mitglied bearbeiten" als Pop-Out
Der bestehende `#detail-card` (aktuell ein `<div style="display:none">`, umgeschaltet über `style.display`) wird zu `<dialog id="detail-dialog">`. Inhalt unverändert (Gruppen-Auswahl, Feld-Inputs, Charakterliste — letztere bekommt in Teil 3 ihre echten Edit/Delete-Icons, existiert aber schon als reine Anzeige). Speichern/Abbrechen-Buttons bleiben funktional identisch (`api.patch('/members/:id', ...)`), nur der Öffnen/Schließen-Mechanismus wechselt auf `showModal()`/`close()`.

**Ungespeicherte-Änderungen-Schutz:** ein Dirty-Flag (`let detailDirty = false`, gesetzt via `input`-Event-Delegation auf `#detail-fields`/`#detail-group`), geprüft an zwei Stellen: (a) beim Klick auf "Schließen"/X — falls dirty, `confirm('Ungespeicherte Änderungen verwerfen?')` vor dem tatsächlichen `.close()`; (b) ein `beforeunload`-Listener, der nur aktiv ist während der Dialog offen UND dirty ist (angemeldet beim Öffnen, abgemeldet beim Schließen/Speichern — kein dauerhaft aktiver Listener, der auch bei sauberem Zustand feuert).

---

## Teil 3: Mitglieder-Verwaltung — Charaktere verwalten

*(Eigener Plan mit erhöhter Backend-Review-Tiefe — dieses Projekt hat bereits mehrfach echte Privilege-Escalation-Bugs speziell in Mitglieder-/Einladungs-Flows gefunden, siehe `db/groupDefaults.js`-Historie und `2026-08-27-10-member-management-invitations.md`s Notable Events.)*

### 3.1 Backend-Erweiterung: `PUT /characters/:id` erlaubt elevated Edit
Aktuell (`backend/characters/routes.js`): `if (character.user_id !== user.id) return { status: 403, ... }` — strikt Besitzer-only, kein Admin-Bypass. Erweitert um `|| user.group.canEditCharacters` (bestätigte Nutzer-Entscheidung: die bestehende, bereits für admin/orga `true` gesetzte Berechtigung wiederverwenden, nicht `canOverrideCheckinStatus` — semantisch die richtige Berechtigung für "darf Charaktere bearbeiten", schon exakt so benannt und schon exakt für admin/orga gesetzt in `db/groupDefaults.js`).

### 3.2 Backend-Erweiterung: `POST /characters` mit optionalem `userId`-Override
Aktuell erstellt `createCharacter(user.id, ...)` immer für den aufrufenden Nutzer selbst. Neuer optionaler Body-Parameter `userId` — nur wirksam, falls `user.group.canEditCharacters` UND der Ziel-Nutzer tatsächlich existiert (404 falls nicht); ohne `canEditCharacters` wird ein mitgesendetes `userId` ignoriert (der Charakter wird immer für den Aufrufer selbst erstellt — verhindert, dass ein normaler Nutzer sich selbst durch einen manipulierten Request-Body höhere Rechte verschafft, gleiche Vorsicht wie bei der bereits bestehenden `group`-Feld-Eskalations-Absicherung in `POST /members/invite`).

### 3.3 Neue Route: `DELETE /characters/:id`
Existiert aktuell überhaupt nicht in der App (bestätigt: kein `router.delete` für Charaktere irgendwo im Code). Neue Route, `requireAuth`, erlaubt Besitzer ODER `canEditCharacters`-Gruppen (gleiche Regel wie 3.1). Löscht die Charakter-Zeile; `character_files` mit `ON DELETE CASCADE` auf `character_id` räumt zugehörige Datei-Metadaten automatisch mit auf (bereits so in Migration `022` angelegt) — die zugehörigen Dateien auf der Festplatte werden dabei NICHT automatisch gelöscht (gleiche bewusste Abwägung wie beim bereits bestehenden `DELETE /characters/:characterId/files/:fileId`: verwaiste Dateien ohne Zugriffsfläche sind harmlos, ein Reaper-Prozess wäre zusätzliche Komplexität ohne aktuellen Bedarf — wird explizit als bekannte, akzeptierte Einschränkung dokumentiert, nicht stillschweigend übergangen).

### 3.4 Frontend: Charakterliste in "Mitglied bearbeiten"
`admin/members.html`s `#detail-characters` (aktuell nur eine reine `<ul>`-Anzeige) bekommt pro Charakter Edit- und Delete-Icons (Material Symbols aus Teil 1) sowie einen "+"-Button für einen neuen Charakter. Klick auf Edit oder Doppelklick auf einen Charakter öffnet ein zweites, verschachteltes `<dialog id="character-edit-dialog">` (das bestehende schema-getriebene Formular aus `characters.html`, wiederverwendet über die gemeinsamen `renderField`/`collectFieldValues`-Helper aus `formFields.js` — kein Duplikat-Formular-Code). Löschen fragt vorher per `confirm()` nach. "+"-Button öffnet dasselbe verschachtelte Dialog im Neu-Anlegen-Modus, sendet `userId` des gerade bearbeiteten Mitglieds mit (Teil 3.2).

---

## Selbst-Review

- **Platzhalter-Scan:** keine TBD/TODO. Einige Detailentscheidungen (exakte CSS-Grid-Struktur, welche Farbvariable fürs Schloss-Icon) sind bewusst der Plan-Erstellung überlassen, wo sie gegen den TATSÄCHLICHEN aktuellen Markup-Stand entschieden werden — das ist bei diesem Projekt üblich (siehe z.B. frühere Pläne, die CSS-Klassen erst gegen das echte Stylesheet prüfen) und kein Platzhalter im Sinne von "unspezifiziert", sondern eine bewusst spät gebundene Implementierungsdetail-Entscheidung.
- **Interne Konsistenz:** Teil 1 richtet das Icon-System (Material Symbols) ein, das Teil 3 ohne erneute Einrichtung mitbenutzt. Teil 3s Berechtigungsentscheidung (`canEditCharacters`) ist an allen drei Stellen (3.1, 3.2, 3.3) identisch angewendet, keine abweichende Regel zwischen den drei neuen/geänderten Routen.
- **Scope-Check:** drei klar geschnittene Pläne, keine echte Abhängigkeit zwischen ihnen (nur nach Risiko sortiert). Teil 3 ist bewusst der aufwändigste und bekommt dafür expliziten Hinweis auf erhöhte Review-Tiefe.
- **Mehrdeutigkeits-Check:** die drei aus der Klärung resultierenden offenen Fragen (Abhängigkeits-Strategie, Berechtigungs-Wiederverwendung, Drag-and-Drop-Umfang) wurden explizit vom Nutzer entschieden, nicht stillschweigend angenommen. Die verwaiste-Datei-Frage bei Charakter-Löschung (3.3) wird als bewusste, dokumentierte Einschränkung behandelt statt stillschweigend gelöst.
