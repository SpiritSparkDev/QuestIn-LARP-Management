# Sidebar-Navigation + Sahara-Redesign — Design Spec

## 1. Problem

Die App hat heute **zwei unterschiedliche, unabhängig gewachsene
Oberflächen**:

- **"Chronicle Crest"** (`frontend/css/chronicle-crest.css`) — dunkles
  Oak/Gold-Fantasy-Theme, zentrierte "Folio"-Karte mit Ecken-Verzierung,
  horizontale Nav-Leiste oben. Genutzt von 9 Seiten: den 6 Auth-Seiten
  (`login.html`, `register.html`, `reset-password.html`,
  `set-password.html`, `verify.html`, `index.html`) sowie `account.html`
  und `characters-browse.html`.
- **"Everest Registry"** (`frontend/css/everest-registry.css`) —
  dunkelblau/petrol-Utility-Theme, **hat bereits eine Sidebar**
  (`.app`/`.sidebar`/`.main`/`.content`). Genutzt von den 7 Admin-Seiten
  (`admin/events.html`, `admin/members.html`, `admin/checkin.html`,
  `admin/groups.html`, `admin/settings.html`, `admin/branding.html`,
  `admin/storage.html`).

Beide rendern ihre Nav-Links über dieselbe Funktion
(`frontend/js/nav.js`s `renderNavLinks`) — nur die umgebende CSS
unterscheidet sich. Der Auftrag "Navigation auf Sidebar umstellen" trifft
also nur die 9 Chronicle-Crest-Seiten; zusätzlich soll die gesamte App auf
ein einheitliches Farb-/Formsystem ("Sahara — Warm Minimalism", Referenz:
`docs/stitch_questin_larp_management_interface/`) umgestellt werden, das
beide bisherigen Theming-Systeme ablöst.

## 2. Ziel

- **Eine** Sidebar-Shell (`.app`/`.sidebar`/`.main`/`.content`, aus dem
  bestehenden Everest-Muster übernommen) für alle 9 Seiten, die heute Nav
  haben — inklusive der 7 Admin-Seiten, die nur neu geskinnt werden.
- **Ein** neues Stylesheet `frontend/css/sahara.css` ersetzt
  `chronicle-crest.css` UND `everest-registry.css`. Beide Dateien werden
  gelöscht.
- Sahara-Farbpalette, EB Garamond (Überschriften) + Manrope (Fließtext/UI,
  ersetzt Work Sans auf den Chronicle-Seiten und Inter auf den
  Admin-Seiten) app-weit, auch auf den 6 Auth-Seiten (ohne Sidebar, dort
  bleibt die zentrierte Karte).
- Sidebar: Logo/Branding oben (nutzt den bestehenden
  `.sidebar-brand`/`.brand-seal`-Hook aus `branding.js` unverändert),
  Nav-Links mit Icons, User-Profil-Chip (Name + Rollenname aus
  `/account`) + Logout unten. Unter einer Breakpoint-Grenze klappt sie weg,
  ein Hamburger-Button öffnet sie als Overlay.
- `account.html`s Konto/Veranstaltung-Tabs wandern als eigene
  Sidebar-Einträge dorthin (Klick schaltet weiterhin nur den sichtbaren
  Tab um, kein Reload, keine Backend-Änderung). Veranstaltung bekommt zwei
  eingehängte Unterpunkte Anmelden/Charaktere, die nur erscheinen, wenn
  Veranstaltung der aktive Top-Tab ist — analog zur Verschachtelung im
  Mockup.
- Bestehende Klassennamen (`.folio`/`.card`, `.ribbon`/`.badge`,
  `.btn-seal`/`.btn`, `.rule`/`.hr`, …) bleiben in der Markup weitgehend
  erhalten — die neue CSS bildet beide auf dieselben Sahara-Regeln ab, statt
  jede der 15 Seiten auf neue Klassennamen umzuschreiben.

## 3. Nicht-Ziel

- Keine Backend-Änderungen. `/account`, `renderNavLinks`s Datenquelle
  (`groups.visible_menus`) und alle API-Endpunkte bleiben unverändert.
- Keine neue Verschachtelungs-/Routing-Logik: Konto/Veranstaltung bleiben
  Client-seitige Tabs auf einer Seite (`account.html`), keine echten
  Unterseiten mit eigener URL — bewusst abweichend vom Mockup, das
  "Charaktere" als eigene Unterseite mit Breadcrumb/Zurück-Link zeigt
  (siehe Abschnitt 6.3).
- Die tieferen Tab-Ebenen in `account.html` (SC/NSC-Umschalter im
  Charaktere-Tab, Allgemein/Merkmale im NSC-Formular) bleiben normale
  horizontale In-Page-Tabs — das sind Formular-Schritte, keine
  Navigationsziele, und gehören nicht in die Sidebar.
- Die Charaktere-Liste bleibt das bestehende Karten-Grid mit
  Datei-Upload/Merkmale-Tags (Funktion, die das Mockup gar nicht zeigt) —
  nur im Sahara-Look neu geskinnt, nicht auf die vereinfachte
  Mockup-Listenzeile reduziert.
- Kein Event-Kontext-Badge auf allen Seiten — nur auf `account.html`
  (dort sind Events/Registrierungen ohnehin schon geladen, siehe
  Abschnitt 6.2). Admin-Seiten brauchen keinen redundanten
  "aktuelles Event"-Hinweis, da `admin/events.html` das schon direkt zeigt.
- Keine neue Font-Lade-Strategie — Manrope kommt über denselben
  Google-Fonts-`<link>`, der heute schon EB Garamond lädt, auf allen 15
  Seiten ergänzt (Work Sans/Inter entfernt).
- Kein Tailwind/CDN-Framework — die neue CSS bleibt handgeschriebenes
  Vanilla-CSS mit denselben CSS-Custom-Properties-Konventionen wie heute,
  passend zum Rest des Projekts (kein Build-Step).

## 4. Farbsystem (`:root`-Tokens in `sahara.css`)

Übernommen aus dem Mockup-Tailwind-Config
(`docs/stitch_questin_larp_management_interface/questin_konto_verwaltung_sidebar/code.html`),
auf die bestehende Chronicle-Crest-Namenskonvention gemappt (Namen bleiben
gleich, Werte ändern sich — minimiert Folgeänderungen an Stellen, die
`var(--surface)` etc. bereits nutzen):

```css
:root {
  --surface: #faf5ee;
  --surface-container-lowest: #ffffff;
  --surface-container-low: #f6f0e8;
  --surface-container: #f2ece4;
  --surface-container-high: #ece6dc;
  --surface-container-highest: #e6e0d6;
  --on-surface: #3a302a;
  --on-surface-variant: #605850;
  --outline: #9a9088;
  --outline-variant: #d8d0c8;
  --primary: #c2652a;
  --primary-deep: #8a4518;
  --primary-container: #fbe8d8;
  --on-primary: #ffffff;
  --on-primary-container: #8a4518;
  --gold: #8c3c3c;              /* zweiter Akzent (vorher: Gold/Teal-Akzent), aus Sahara "tertiary" (dusty rose) */
  --gold-container: #fce0e0;
  --on-gold-container: #3a2020;
  --secondary: #78706a;
  --secondary-container: #eae2da;
  --error: #c0392b;
  --success: #2c5223;
  --shadow: rgba(58, 48, 42, 0.06);
}

body {
  background: var(--surface);       /* kein dunkler "Oak"-Hintergrund mehr -- die ganze App ist hell */
  font-family: "Manrope", system-ui, sans-serif;
}

h1, h2, h3 {
  font-family: "EB Garamond", Georgia, serif;   /* unverändert */
}
```

Der dunkle `--oak`-Seitenhintergrund entfällt komplett — Sahara ist
durchgehend hell (Mockup zeigt keinen abgesetzten dunklen Rahmen um die
App). `body`s bisheriger Radial-Gradient-Hintergrund und `padding: 48px
20px 80px` (für die zentrierte Karte gedacht) entfallen ebenso für
Sidebar-Seiten — die neue `.app`-Shell nutzt die volle Viewport-Breite/höhe
(wie es `everest-registry.css`s `.app` heute schon tut). Auf den 6
Auth-Seiten (keine Sidebar) bleibt der zentrierte `.shell`/`.folio--narrow`-
Aufbau bestehen, nur mit den neuen Tokens.

## 5. Sidebar-Shell

Übernimmt die bestehende Everest-Struktur (`.app`/`.sidebar`/`.main`/
`.content`), erweitert um Icons, Verschachtelung, User-Chip und
mobiles Hamburger-Verhalten:

```html
<div class="app">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-top">
      <div class="brand-seal"></div>
      <div class="sidebar-brand">Pakyrion<span>LARP Management</span></div>
    </div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot">
      <div class="sidebar-user">
        <div class="sidebar-user-avatar">AS</div>
        <div class="sidebar-user-info">
          <p class="sidebar-user-name">Alexander von Steinberg</p>
          <p class="sidebar-user-role">Teilnehmer</p>
        </div>
        <button type="button" id="logout-link" class="sidebar-logout" title="Abmelden">
          <span class="material-symbols-outlined">logout</span>
        </button>
      </div>
    </div>
  </aside>
  <button type="button" id="sidebar-toggle" class="sidebar-toggle" aria-label="Menü öffnen">
    <span class="material-symbols-outlined">menu</span>
  </button>
  <div class="main"><div class="content">
    <!-- Seiteninhalt -->
  </div></div>
</div>
```

- `.sidebar-top` (Logo/Branding) ersetzt das bisherige `.brand`/
  `.brand-seal`/`.brand-name`-Trio, das heute oberhalb der Karte
  zentriert stand — wandert unverändert funktional (gleiche
  `branding.js`-Hooks: `.brand-seal` für ein hochgeladenes Logo,
  `.sidebar-brand` für den Textnamen) in die Sidebar.
- `renderNavLinks(account, path)` bleibt inhaltlich unverändert (gleiche
  Menü-Keys aus `groups.visible_menus`), bekommt aber pro Eintrag ein
  Material-Symbols-Icon vor dem Label (Mapping in Abschnitt 7).
- Der User-Chip (Name, Rollenname, Logout) ersetzt das bisherige
  `.header-actions`-Logout-Button-oben-rechts. Name kommt aus
  `account.name` (bereits fertig aufbereitet vom Backend,
  `backend/accounts/repository.js:13`), Rolle aus `account.group.name`
  (beide schon Teil der `/account`-Antwort — keine Backend-Änderung
  nötig). Initialen fürs Avatar: erste Buchstaben von Vor-/Nachname,
  client-seitig berechnet.
- **Mobil (< 900px):** `.sidebar` verschwindet (`transform:
  translateX(-100%)`), `#sidebar-toggle` (Hamburger, nur unterhalb dieser
  Breite sichtbar) schaltet eine `.sidebar--open`-Klasse auf `.sidebar`,
  die sie als Overlay über den Content schiebt (`position: fixed`,
  Schatten, Klick außerhalb oder erneuter Hamburger-Klick schließt sie).
  Neues kleines Skript in `nav.js`, exportiert als `initSidebarToggle()`,
  von jeder Seite nach dem Rendern der Nav aufgerufen (ein Aufruf pro
  Seite, analog zu `renderNavLinks`).

## 6. `account.html`: Tabs → Sidebar

### 6.1 Konto/Veranstaltung als Sidebar-Einträge

`renderNavLinks` liefert nach wie vor nur die echten Menü-Keys (aktuell:
`konto`, plus für Admin/Moderator `mitglieder`/`events`/`checkin` usw.).
"Veranstaltung" ist **kein** Menü-Key (das Merge aus der letzten Session
hat `charaktere`/`con-anmeldungen` bewusst entfernt) — es existiert nur
als In-Page-Tab auf `account.html`. `account.html`s eigenes Skript rendert
deshalb zusätzlich, direkt nach dem "Konto"-Link, einen zweiten
Nav-Block ins selbe `<nav id="nav-links">`:

```html
<button type="button" class="sidebar-nav-item sidebar-tab-btn active" data-tab="konto-tab">
  <span class="material-symbols-outlined">manage_accounts</span><span>Konto</span>
</button>
<button type="button" class="sidebar-nav-item sidebar-tab-btn" data-tab="veranstaltung-tab">
  <span class="material-symbols-outlined">event</span><span>Veranstaltung</span>
</button>
<div class="sidebar-nav-nested" id="veranstaltung-subnav" hidden>
  <button type="button" class="sidebar-nav-item sidebar-tab-btn active" data-tab="anmelden-subtab">Anmelden</button>
  <button type="button" class="sidebar-nav-item sidebar-tab-btn" data-tab="charaktere-subtab">Charaktere</button>
</div>
```

Diese Buttons ersetzen die bisherigen `#page-tabs`/`#veranstaltung-
subtabs`-`<button class="tab-btn">`-Leisten 1:1 in ihrer Funktion — die
bestehende `initTabs(tabsEl)`-Funktion (generisches Klick-Handling,
toggelt `.active` + Panel-`hidden`) wird auf diese neuen Container
angewendet, keine neue Tab-Logik nötig, nur ein neuer Ziel-Container
(die Sidebar-`<nav>` statt der bisherigen In-Page-`.tabs`-Divs) und eine
CSS-Klasse mehr (`.sidebar-nav-item` fürs Sidebar-Aussehen der Buttons).
`#veranstaltung-subnav` wird ein-/ausgeblendet, je nachdem ob der
"Veranstaltung"-Button aktiv ist (kleine Ergänzung zu `initTabs`s
Klick-Handler, nur für diesen einen Button).

Die bisherigen In-Page-`.tabs`-Leisten für Konto/Veranstaltung
(`#page-tabs`, `#veranstaltung-subtabs`) entfallen aus dem `.content`-
Bereich — ihr Markup wandert wie oben gezeigt in die Sidebar, ihre
Ziel-Panels (`#konto-tab`, `#veranstaltung-tab`, `#anmelden-subtab`,
`#charaktere-subtab`) bleiben unverändert an Ort und Stelle im
`.content`-Bereich.

### 6.2 Event-Badge (nur `account.html`)

Optionaler kleiner Hinweis in `.sidebar-foot`, oberhalb des User-Chips,
zeigt den Namen des aktuell aktiven Events (falls vorhanden) — nutzt
`loadQrCode`s bereits geladene `events`-Liste (kein zusätzlicher
API-Call): `events.find(e => e.is_active)`. Erscheint nur, wenn ein
aktives Event existiert; sonst bleibt der Platz leer (kein Platzhaltertext
nötig, kein Fehlerzustand).

### 6.3 Bewusste Abweichung vom Mockup

Das Mockup zeigt "Charaktere" als eigene Unterseite mit
Breadcrumb ("Charaktere / Neuen Charakter anlegen") und
Zurück-Link — echte Navigation zwischen Listen- und Erstellungs-Ansicht.
Diese Spec übernimmt das NICHT: Charaktere-Liste und
Charakter-Erstellungsformular bleiben wie heute gemeinsam auf einem Panel
sichtbar (Liste oben, Formular darunter), keine echte Unterseite. Grund:
explizite Entscheidung, die gerade erst gebaute 1-Seiten-Tab-Struktur
(inkl. Backend-Menü-Konsolidierung der letzten Session) nicht wieder
aufzubrechen.

## 7. Icon-Zuordnung (Material Symbols Outlined, bereits als Font geladen)

| Menü-Key / Tab | Icon |
|---|---|
| `konto` | `manage_accounts` |
| Veranstaltung (Tab) | `event` |
| Anmelden (Sub-Tab) | `how_to_reg` |
| Charaktere (Sub-Tab) | `shield` |
| `mitglieder` | `group` |
| `events` | `calendar_month` |
| `checkin` | `qr_code_scanner` |
| `gruppen` | `groups` |
| `einstellungen` | `settings` |
| `branding` | `palette` |
| `speicher` | `storage` |

`MENU_LINKS` in `frontend/js/nav.js` bekommt pro Eintrag ein neues Feld
`icon` mit dem jeweiligen Symbol-Namen; `renderNavLinks` rendert
`<span class="material-symbols-outlined">${icon}</span>` vor dem Label.

## 8. Komponenten-Vereinheitlichung (keine Massen-Umbenennung im Markup)

`sahara.css` definiert jede Komponente EINMAL und mappt beide
Alt-Namenssysteme darauf, statt Markup in 15 Dateien umzuschreiben:

| Rolle | Alte Namen (bleiben im Markup gültig) | Neuer Look |
|---|---|---|
| Karte/Sektion | `.folio` (Chronicle), `.card` (Everest) | Weiß, `border-radius: 12px`, `box-shadow: 0 1px 3px var(--shadow)`, kein Ecken-Verzierung mehr (`.folio::before/::after` entfällt) |
| Primär-Button | `button[type="submit"]`, `.btn-seal`, `.btn` (Everest, Default) | Voll gefüllt Sienna, `border-radius: 8px`, kein Siegel-Schatten-Effekt mehr |
| Sekundär/Ghost-Button | `.btn-ghost`, `.btn-secondary` | Text/outline, Sienna |
| Danger-Button | `.btn-danger` | Unverändert (rot, nur Tokens neu) |
| Status-Badge | `.ribbon` + `.status-*` (Chronicle), `.badge`/`.status-pill` + `.status-*` (Everest) | EIN Pill-Stil (Everest-Form ohne Clip-Path), gleiche `.status-*`-Modifikatoren wie heute |
| Divider | `.rule` (Chronicle), `.hr` (Everest) | Gleiche dünne Linie |
| Eingabefeld | `input`/`select`/`textarea` (beide Systeme, schon elementweise gestylt) | Umgestellt von Chronicle's Unterstrich-Stil auf den gebox­ten Stil (Border, `border-radius: 8px`, Label als kleine Caps-Zeile darüber) — das ist Everest's heutiger Stil, wird zum einzigen Stil |

**Ausnahme, echte Markup-Änderung nötig:** `account.html`s
`loadRegistrations()` erzeugt aktuell `<span class="ribbon
status-${status}">` per Template-String (`frontend/account.html`, im
gemergten Skript) — wird auf `status-pill status-${status}` umgestellt
(eine Zeile), damit es densel­ben Pill-Stil wie die Admin-Tabellen nutzt
statt der wegfallenden Ribbon-Form.

## 9. Datei-Übersicht

| Datei | Änderung |
|---|---|
| `frontend/css/sahara.css` | **Neu.** Ersetzt beide bisherigen Stylesheets vollständig. |
| `frontend/css/chronicle-crest.css` | Gelöscht. |
| `frontend/css/everest-registry.css` | Gelöscht. |
| `frontend/js/nav.js` | `MENU_LINKS`-Icons, `initSidebarToggle()`-Export für den mobilen Hamburger. |
| `frontend/js/branding.js` | Unverändert (Selektoren `.brand-seal`/`.sidebar-brand`/`.brand-name` bleiben gültig). |
| `frontend/account.html` | Shell auf `.app`/`.sidebar`/`.main`/`.content` umgestellt; Konto/Veranstaltung-Tab-Leiste entfernt, stattdessen Sidebar-Nav-Buttons (6.1); Event-Badge (6.2); Registrierungs-Ribbon → Status-Pill (8). |
| `frontend/characters-browse.html` | Shell auf Sidebar umgestellt (war bisher `.shell`/`.folio--wide` + `.app-nav`, noch nicht Everest-Struktur). |
| `frontend/admin/events.html`, `members.html`, `checkin.html`, `groups.html`, `settings.html`, `branding.html`, `storage.html` | Shell bleibt `.app`/`.sidebar`/`.main`/`.content` (unverändert an Struktur), `<link>` auf `sahara.css` umgestellt, Google-Fonts-`<link>` auf EB Garamond+Manrope umgestellt (statt nur Inter), `sidebar-brand`-Icon-Ergänzung optional (kein Pflichtfeld je Seite, da `nav.js` das zentral rendert). |
| `frontend/login.html`, `register.html`, `reset-password.html`, `set-password.html`, `verify.html`, `index.html` | `<link>` auf `sahara.css` umgestellt, Google-Fonts-`<link>` auf EB Garamond+Manrope umgestellt. Struktur (`.shell`/`.brand`/`.folio--narrow`) unverändert — nur neue Tokens/Schrift. |

## 10. Responsive Verhalten

- **≥ 900px:** Sidebar fix sichtbar (`position: sticky` oder `fixed`,
  wie heute bei Everest), Content daneben.
- **< 900px:** Sidebar per Default verborgen, Hamburger-Button
  (`#sidebar-toggle`, nur in diesem Breakpoint sichtbar) öffnet sie als
  Overlay über den Content. Ersetzt Everest's heutiges Verhalten
  (Sidebar klappt zur horizontalen Leiste über dem Content) — diese Spec
  entscheidet sich für die im Vorgespräch bestätigte
  Overlay-Variante statt der heutigen Stack-Variante.
- Breakpoint 900px gewählt (nicht 768px wie Everest heute, nicht 1024px
  wie Chronicle heute) als Kompromiss zwischen den zwei bisherigen
  Werten — kein funktionaler Unterschied, der einen bestimmten Wert
  erzwingt.

## 11. Tests / Verifikation

Kein Frontend-Test-Framework in diesem Projekt (wie schon bei der
letzten Session). Verifikation erfolgt manuell/statisch:

- Jede der 15 Seiten wird auf `<link>`-Ziel (`sahara.css`), vollständige
  Sidebar-Struktur (bei den 9 Nav-Seiten) bzw. unveränderte
  Auth-Shell-Struktur (bei den 6 Auth-Seiten) geprüft.
- `account.html`s Sidebar-Tab-Wiring wird wie beim letzten Umbau
  statisch nachvollzogen (jede `data-tab`-Referenz gegen ein existierendes
  Panel, `initTabs`-Aufrufe für jede Ebene).
- Kein Backend-Test betroffen — reine Frontend-Umstellung, `npm test`
  läuft nur als Regressions-Smoke-Check (sollte unverändert grün bleiben,
  da kein Backend-Code berührt wird).
- Mobiles Hamburger-Verhalten wird, wo möglich, im Browser-Vorschau-Tool
  mit `resize_window` (mobile Preset) geprüft.

## 12. Rollout-Risiko

- Rein clientseitig, keine Migration, kein Datenverlust möglich.
- Größtes Risiko: der Umbau berührt buchstäblich jede Seite der App
  gleichzeitig (15 Dateien) — ein CSS-Fehler in `sahara.css` wirkt sich
  sofort auf alles aus. Deshalb: schrittweiser Aufbau (erst `sahara.css`
  fertig und gegen 1-2 Seiten verifizieren, bevor die übrigen 13 Seiten
  umgestellt werden), nicht alle 15 Seiten parallel anfassen, bevor das
  Stylesheet stabil ist.
- Zwei alte Stylesheets werden gelöscht — vor dem Löschen sicherstellen,
  dass keine Seite mehr auf sie verlinkt (Grep-Check am Ende).
