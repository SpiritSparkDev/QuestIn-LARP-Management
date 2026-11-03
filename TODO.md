# TODO

Stand: 2026-11-04 (nach v0.83.0). Drei Abschnitte: **Offen** (angefangen oder
bewusst verschoben), **Technische Schulden** und **Feature-Ideen** (Vorschläge,
nichts davon ist beauftragt). Ältere zurückgestellte Punkte stehen zusätzlich in
`docs/superpowers/roadmap.md`; vor dem Anfassen eines Punkts gegen den
aktuellen Code prüfen.

## Offen

### Zahlungen / Gruppen (v0.80–0.83)

- [ ] **Manueller Browser-Test** des Zahlungsassistenten (Einzel- und
  Gruppenmodus): alle Schritte, Girocode, „Ich habe überwiesen“, Zurück-Button,
  Rückkehr von Stripe/SumUp/PayPal mit `?payment=success#gruppe`. Bisher nur
  Syntax-, ID- und Integrationstests, kein Klick-Test.
- [ ] **Sammelzahlung bei einem echten Anbieter** (Testzugänge) auslösen und
  prüfen, dass alle Personen als bezahlt erscheinen: Stripe (Karte und
  Stripe-Überweisung), SumUp, PayPal direkt, PayPal-Buttons. Bisher nur mit Mocks.
- [ ] **Überzahlung bei Sammelzahlung:** Hat eine Person zwischen Start und
  Eingang der Zahlung schon anders bezahlt, wird sie übersprungen und nur
  geloggt (`recordGroupPayment`). Es gibt keine automatische Rückerstattung und
  keinen Hinweis für die Orga. Mindestens ein Eintrag im Protokoll bzw. Dashboard.
- [ ] **Rückerstattung gruppengezahlter Anmeldungen** gegen Stripe prüfen:
  mehrere Teilerstattungen auf denselben Payment Intent (laut Stripe erlaubt,
  nicht getestet).
- [ ] **Offline-Modus:** Prüfen, dass die neuen Routen
  `/events/:id/group-payment/checkout-session` und `…/paypal-order` im
  Offline-Betrieb (`APP_MODE=offline`) sauber ablehnen. `getBankInfo` blendet
  Online-Anbieter dort aus, die Routen selbst wurden nicht darauf geprüft.
- [ ] **Protokoll-Doku:** `docs/log-ereignisse.md` um Sammelzahlungen ergänzen
  (eine Zahlung erzeugt je Person einen Eintrag, Anbieter-Referenz mit Suffix
  `#<userId>`).
- [ ] **Tiefer verschachtelte Untergruppen:** Die Sammelzahlung erfasst
  verwaltete Personen und direkte Untergruppen-Mitglieder (gleiche Regel wie
  `canRegisterFor`), nicht tiefere Ebenen. Klären, ob das so gewollt ist.
- [ ] **Hilfe/Betriebsdoku** für die zwei Verwendungszweck-Vorlagen
  (Einzel/Gruppe) in `docs/` ergänzen, falls dort die Zahlungs-Einstellungen
  beschrieben sind.

### Sonstiges

- [ ] **Test-Container `db-test`** (docker-compose.dev.yml) läuft nach
  Testläufen weiter; bei Bedarf stoppen.

## Technische Schulden

- [ ] **Testdateien nicht parallel starten:** Mehrere Integrationstests teilen
  sich die eine Zeile in `payment_settings` und stören sich bei paralleler
  Ausführung. `npm test` nutzt `--test-concurrency=1`, einzelne Aufrufe von
  Hand brauchen es ebenfalls. Entweder pro Test aufräumen oder dokumentieren.
- [ ] **Migrationsnummern bei parallelen Sessions:** In dieser Session war
  Nummer 128 doppelt vergeben (Funke und Bank-Vorlage), `migrationFiles.test.js`
  hat es erst bei der Suite gemeldet. Vor dem Commit einer Migration immer
  `ls db/migrations` und `git fetch` prüfen.
- [ ] **`events.code` ohne Unique-Constraint** und im Admin-Event-Listing nicht
  sichtbar (aus der Roadmap).
- [ ] **`db/seedGroups.js`** ist seit Migration 014 faktisch ein No-Op: löschen
  oder bewusst behalten (aus der Roadmap).
- [ ] **`frontend/account.html`** ist sehr groß (Zahlungsassistent, Gruppen-Tab,
  Anmeldung in einer Datei). Der Zahlungsassistent wäre ein guter Kandidat, um
  ihn in ein eigenes Modul (`frontend/js/paymentDialog.js`) auszulagern, sobald
  er das nächste Mal angefasst wird.

## Feature-Ideen (Vorschläge)

Grob nach Nutzen sortiert, jeweils mit dem Grund, warum es zum Stand passt.

1. **Kontoauszug-Abgleich** (CSV / CAMT.053 / MT940 importieren). Der
   Verwendungszweck ist jetzt per Vorlage steuerbar und eindeutig; der Import
   könnte Überweisungen automatisch zuordnen und die Anmeldungen als bezahlt
   markieren. Das spart der Orga das manuelle Buchen im Check-In, besonders bei
   Sammelüberweisungen.
2. **Sammelüberweisung in einem Schritt bestätigen** (Orga-Seite): Heute bucht
   die Orga jede Person einzeln, obwohl eine Überweisung für mehrere kam.
   „Gruppenzahlung bestätigen“ sollte alle zugehörigen Personen auf einmal als
   bezahlt markieren (die gemeldeten Personen stehen als `transfer_notified_at`
   schon fest).
3. **Teilzahlungen / Anzahlung:** Aktuell wird eine Zahlung nur gebucht, wenn
   sie den offenen Betrag deckt (Stripe, SumUp und PayPal prüfen
   `betrag >= fällig`). Eine Anzahlung oder Ratenzahlung ist damit nicht
   abbildbar.
4. **Zahlungserinnerungen automatisieren:** Es gibt schon
   `sendPaymentReminderEmail` und die Dashboard-Erinnerung für
   Überweisungen, die nach drei Tagen unverbucht sind. Prüfen, ob ein
   automatischer Versand (z. B. 7 Tage vor Eventbeginn an alle mit offenem
   Betrag, auch an Gruppenverwalter für ihre Personen) fehlt.
5. **Verwendungszweck-Vorlage pro Event** statt global (z. B. andere Kennung
   oder Sprache bei internationalen Events) und weitere Platzhalter aus
   Anmeldefeldern (Teilnahmegruppe, Mitgliedsnummer).
6. **Gruppen-Übersicht für die Orga:** Pro Gruppenverwalter Summe,
   bezahlt/offen und gemeldete Überweisungen auf einen Blick, mit Export (CSV
   gibt es für Mitglieder bereits).
7. **Gruppenmitglied zahlt selbst für andere:** Heute zahlen nur
   Gruppenverwalter für ihre Personen. Optional einen Zahlungslink, den ein
   Verwalter an Mitglieder schicken kann („bezahle deinen Anteil“), ohne dass
   diese ein Konto brauchen (Muster: Gast-Zahlungslink `guest-payment.html`).
8. **Quittung / Rechnung als PDF** nach Zahlungseingang, bei Sammelzahlung eine
   gemeinsame Rechnung an den Zahler. Es gibt bereits einen PDF-Export-Add-on.
9. **Zahlungs-Dashboard:** Offene Beträge, Eingänge pro Anbieter und Tag,
   Überzahlungen und fehlgeschlagene Buchungen, gespeist aus dem
   Zahlungsprotokoll.
10. **Platzhalter-Vorschau auch für E-Mail-Vorlagen:** Die Live-Vorschau der
    Verwendungszweck-Vorlage war schnell gebaut und ist gut angekommen; gleiche
    Art Vorschau mit Beispieldaten für die E-Mail-Vorlagen unter
    „E-Mail-Vorlagen“.
