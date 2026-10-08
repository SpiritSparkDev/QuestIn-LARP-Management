# Mobil-Audit

Stand: 2026-10-08. Werkzeug: `scripts/mobile-audit.mjs` (Playwright, siehe Kopfkommentar). Läuft gegen eine Test-/Entwicklungsinstanz mit Testdaten (Admin-Einstellungen, „Testdaten“), je Seite und Bildschirmbreite 360, 390, 430 und 768 px. Es meldet seitliches Scrollen, überstehende Elemente, Dialoge höher als der Bildschirm und zu kleine Tippflächen (unter 36 px) und legt Screenshots ab.

## Befunde und Behebung
| Befund (360/390 px) | Ursache | Behebung |
|---|---|---|
| Seite scrollt seitlich in Mitglieder und Check-in | Karten-Zeilen mit Label und mehreren Buttons brachen nicht um; lange Texte (E-Mail, Namen) brachen nicht | Zellen umbrechen, Kinder `min-width: 0`, `overflow-wrap: anywhere` |
| Statuskachel im Check-in ragt heraus | `.stat-row` ohne Umbruch | `flex-wrap: wrap` |
| Tippflächen 18 bis 35 px (Logout, Hilfe-Links, Umschalter, Toast-Schließen, Tabs, kleine Buttons, Modus-Chip) | Desktop-Maße | auf Touch-Geräten (`pointer: coarse`) mindestens 40 bis 44 px |
| Hilfe-Reiter verdeckt Kartentext | Reiter am Bildschirmrand mit Beschriftung | unter 700 px nur Symbol |

Ergebnis des Laufs: 0 blockierende Befunde bei 360, 390 und 430 px (Mitglieder, Events inkl. Bearbeiten, Check-in, Einstellungen).

## Nicht als Fehler zu werten
- `ERR_TUNNEL_CONNECTION_FAILED`: in der Entwicklungsumgebung ist der Zugriff auf externe Schriften/CDN gesperrt.
- `404` auf `/tavern/items`: das Tavernen-Add-on ist in der Testinstanz ausgeschaltet.

## Offen
- Event-Bearbeitung und Mitglieder-Detail: der Dialog-Schritt des Skripts findet seine Schaltflächen nicht zuverlässig (im Lauf als „step not found“ gemeldet); Sichtprüfung am Handy steht aus.
- Echtgerätetest (Punkt 13) und Sichtprüfung der Charakter-Bearbeitung am Handy.
