# P1 Echtgerätetest (Check-in-QR-Scan + Taverne) — Plan

**Bezug:** `docs/offene-punkte.md` Punkt 13. Bisher nur simulierte Geräte.
**Art:** Überwiegend manuelle Abnahme, dazu kleine Code-Härtungen, die der Test voraussichtlich aufdeckt.

## Ziel
Vor dem nächsten Con ist belegt, dass Check-in per QR-Scan und die Taverne auf echten Handys (iOS Safari, Android Chrome) im Produktivsetup funktionieren.

## Bestand
- Scan: `frontend/admin/checkin.html` (jsQR in `frontend/vendor/jsQR.js`, `getUserMedia` mit `facingMode: 'environment'`, Torch-Button, 20-s-Scan, Dialog `scan-dialog`).
- Backend: `GET /events/:eventId/scan-lookup`, `PUT /events/:id/checkin/:userId`.
- Taverne: `frontend/admin/tavern.html`, Routen unter `/tavern/*`.

## Vorbedingungen
- Prod-nahe Umgebung mit **HTTPS** (Kamera funktioniert in Browsern nur über HTTPS bzw. localhost) — Staging-Event mit Testdaten, Test-Modus (`/test-mode`) einschalten.
- Mind. 2 Geräte: iPhone (Safari) und Android (Chrome); optional ein günstiges Altgerät.
- 10 Test-Teilnehmer mit Tickets (QR aus Ticketseite, auch ausgedruckt und auf Bildschirm), darunter: Con-Zahler, unbezahlt, bereits eingecheckt, Gast ohne Account, Teilnehmer ohne QR-Kennung des Events.

## Schritt 1 — Testprotokoll anlegen
Neue Datei `docs/testprotokoll-echtgeraete.md` (Vorlage, pro Durchlauf Datum/Gerät/OS/Browser/Ergebnis). Checklisten unten sind der Inhalt.

## Schritt 2 — Check-in-Checkliste (je Gerät)
1. Seite `/checkin` öffnen, Kamera-Berechtigung erteilen; Ablehnen der Berechtigung → sinnvolle Fehlermeldung statt leerer Fläche.
2. Scan-Start: Video erscheint, Rückkamera aktiv, Fokus ok.
3. Scan bei: Sonnenlicht, Innenraum, schlechtem Licht (Torch an/aus; Torch-Button erscheint nur, wo unterstützt).
4. QR vom Bildschirm (verschiedene Helligkeit) und vom Papierausdruck (A6 und Handyfoto-Größe).
5. Dialog zeigt Name, Gruppe, Status, Charaktere; Warnungen für unbezahlt/Con-Zahler/bereits eingecheckt/anderes Event korrekt.
6. „Einchecken" bestätigen → Status in Liste aktualisiert; Doppelscan zeigt Hinweis, keinen zweiten Check-in.
7. 20-s-Timeout, erneuter Scan, Seitenwechsel/Hintergrund-App (Kamera wird freigegeben, kein „Kamera in Benutzung"-Zustand danach).
8. Querformat/Hochformat, Bildschirmsperre, instabiles Netz (Flugmodus-Wechsel während Scan → verständliche Fehlermeldung, kein Doppel-Check-in nach Retry).
9. Parallel: zwei Geräte checken denselben Teilnehmer gleichzeitig ein → ein Check-in, kein Fehlerzustand.
10. Messen: Zeit pro Teilnehmer (Ziel < 10 s inkl. Bestätigung).

## Schritt 3 — Taverne-Checkliste
1. Kasse am Handy: Teilnehmerliste/Suche, Artikelauswahl, Buchung (`charge`), Stornierung (`void`).
2. Hartes Sperren bei zu wenig Guthaben (kein Dispo) mit klarer Meldung.
3. Auszahlung (`payout`) inkl. Hinweis in der Kasse.
4. Tagesabrechnung (`/tavern/report`) und CSV-Export (`/tavern/export`) öffnen/herunterladen auf Mobilgeräten (iOS: Download-Verhalten prüfen).
5. Gast-Sicht `my-balance` auf dem eigenen Handy.
6. Doppeltipp auf „Buchen" darf nicht doppelt buchen (Button sperren / Idempotenz prüfen — falls nicht gegeben, siehe Schritt 4).

## Schritt 4 — Erwartbare Code-Härtungen (nur wenn der Test sie bestätigt)
Jede als eigener kleiner Commit mit Test:
- **Doppelbuchung/Doppel-Check-in:** Button nach Klick deaktivieren, serverseitig idempotent (Check-in ist es per Status; Taverne-`charge` ggf. Request-Key oder Sperrfenster prüfen).
- **Kamera-Fehlertexte:** `NotAllowedError`, `NotFoundError`, `OverconstrainedError`, unsicherer Kontext (HTTP) je eigener deutscher Hinweis in `checkin.html`.
- **Offline/Netzfehler:** Scan-Ergebnis erst nach erfolgreicher Antwort bestätigen, deutlicher Fehlerzustand statt stiller Wiederholung.
- **iOS-Besonderheiten:** `playsinline`, `muted` vorhanden; prüfen, ob Video nach Orientierungswechsel stehen bleibt.
- Torch-Toggle nur anzeigen, wenn `track.getCapabilities().torch`.

## Abnahmekriterien
- Beide Checklisten auf mindestens einem iOS- und einem Android-Gerät vollständig durchlaufen, Abweichungen als Issues/Commits erfasst.
- Protokoll ins Repo (`docs/testprotokoll-echtgeraete.md`) und Punkt 13 in `docs/offene-punkte.md` aus „Zurückgestellt" nach „Entschieden/Erledigt" verschoben.
- Test-Modus nach dem Test ausschalten und Testdaten entfernen.

## Aufwand / Reihenfolge
~0,5 Tag Test + 0,5–1 Tag Fixes. Zusammen mit P2 am gleichen Tag durchführbar (gleiche Geräte). Keine Versionsänderung für das Protokoll (`docs:`); Fixes sind `fix:` → PATCH-Bump nach CLAUDE.md-Regel.
