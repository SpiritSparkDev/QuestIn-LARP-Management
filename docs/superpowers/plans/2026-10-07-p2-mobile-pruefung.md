# P2 Mobile Prüfung (Event-Bearbeitung, Charakter-Bearbeitung, Mitglieder-Fenster) — Plan

**Bezug:** `docs/offene-punkte.md` Punkt 14.

## Ziel
Die drei Bereiche sind auf Handy-Breite (360–430 px) bedienbar: kein horizontales Scrollen der Seite, alle Aktionen erreichbar, Dialoge passen in den Viewport.

## Bestand
- Frontend ohne Framework: `frontend/admin/events.html`, `frontend/admin/members.html`, Charakter-Bearbeitung in `frontend/account.html` / `frontend/managed-person.html`, Styles in `frontend/css/`, Tabellen-Helfer `frontend/js/responsiveTables.js`.
- Es gibt bereits responsive Teile (`responsiveTables.js`); unklar ist die Abdeckung der drei Bereiche.

## Schritt 1 — Audit (automatisiert mit Playwright, Chromium ist vorinstalliert)
- Skript außerhalb von `tests/` (z. B. `scripts/mobile-audit.mjs`), nutzt `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, kein `playwright install`.
- Start über `docker compose -f docker-compose.dev.yml up`, Admin per `seed-admin` einloggen.
- Viewports: 360×740, 390×844, 430×932; zusätzlich 768×1024 (Tablet).
- Je Seite/Zustand prüfen und Screenshot ablegen (Scratchpad, nicht ins Repo):
  - `document.documentElement.scrollWidth > clientWidth` → horizontaler Overflow (Liste der überstehenden Elemente ausgeben).
  - Klickziele < 40 px Höhe.
  - Fixierte Elemente/Dialoge, die höher als der Viewport sind und nicht scrollen.
- Zustände: Event-Liste, Event bearbeiten (alle Tabs/Abschnitte inkl. Preis-Editor mit Preisstufen-Karten, Unterkünfte, Extras, Flags), Charakter bearbeiten (alle Schema-Abschnitte, Datei-Upload, Portrait), Mitglieder-Liste, Mitglieder-Fenster (Status-Dropdown, Registrierungen, OT-Felder, Con-Zahler/Con-Rolle), Rundmail-Editor.

## Schritt 2 — Befunde priorisieren
Tabelle in `docs/mobile-audit.md`: Seite | Viewport | Problem | Schwere (blockierend / lästig / kosmetisch) | Fix-Ansatz.

## Schritt 3 — Fixes (Muster)
- Breite Tabellen: `responsiveTables.js` auf betroffene Tabellen anwenden (Kartenansicht < 640 px) statt Seite verbreitern.
- Formularraster: `grid-template-columns` auf `minmax(0, 1fr)` mit Media-Query einspaltig.
- Dialoge (`<dialog>`): `max-height: 100dvh`, inneres Scrollen, Schließen-Button sichtbar.
- Aktionsleisten: umbrechen (`flex-wrap`), Primäraktion unten sticky, wenn Formular lang.
- Touch-Ziele min. 44 px; `font-size >= 16px` in Inputs (verhindert iOS-Zoom).
- **Nicht anfassen:** die `${key}-container`-Wrapper in `frontend/js/formFields.js` (siehe CLAUDE.md) — Layout über CSS auf dem Container, nicht durch Entfernen.
- Jeder Fix: kleiner Commit `fix:`/`style:`; reine CSS-Änderungen `style:` (kein Versionsbump), sichtbare Bedienbarkeitsfixes `fix:`.

## Schritt 4 — Regression
- Audit-Skript nach Fixes erneut laufen lassen; Ergebnis „0 blockierend, 0 Overflow" in `docs/mobile-audit.md` festhalten.
- Optional: schlanker Smoke-Test, der die drei Seiten bei 390 px lädt und `scrollWidth <= clientWidth` prüft (nur wenn Playwright ohnehin in CI laufen soll, siehe P6; sonst weglassen).

## Abnahme
- Echtgerät-Sichtprüfung der drei Bereiche beim Termin aus P1.
- Punkt 14 in `docs/offene-punkte.md` abgehakt.

## Aufwand
~1 Tag Audit + 1–2 Tage Fixes, je nach Befund.
