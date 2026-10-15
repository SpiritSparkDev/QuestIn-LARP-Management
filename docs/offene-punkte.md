# Offene Punkte (Stand 2026-10-15)

Entscheidungen zur Fragenliste: Wo nichts anderes gesagt wurde, gilt die jeweilige Empfehlung.

## Entschieden
- **Tavernenkonto:** Kein Online-Aufladen (Stripe/PayPal) durch Gäste. Kein Dispo, Konten werden hart gesperrt, wenn das Guthaben nicht reicht. Umgesetzt werden Tagesabrechnung, CSV-Export der Buchungen und die Buchungsart "Auszahlung" (Restguthaben) mit Hinweis in der Kasse.
- **PDF-Import:** Pro Event voraussichtlich nur eine Vorlage. Gruppen-PDFs sind nicht vorgesehen (keine Übernahme als verwaltete Personen). Die Einverständniserklärung muss einem PDF-Feld zugeordnet sein, sonst lehnt die Übernahme ab.
- **Test-Modus:** Bleibt wie er ist, keine zusätzliche Absicherung auf Produktivservern.
- **Charaktere in fremden Accounts anlegen:** Weiterhin nur Admin und Moderator (fest im Code); ein Gruppenrecht erst, wenn es gebraucht wird.
- **Staff-Felder an eigenen Charakteren:** Erlaubt, aber mit Protokoll (wer hat wann welches Feld geändert).
- **CSV-Export:** Jeder Export wird protokolliert; sensible Felder (z. B. Gesundheitshinweise) nur mit eigenem Recht. Eine CSV der Check-In-Liste kommt dazu.

## Ideen ohne Entscheidung
- Massenaktionen in der Mitgliederverwaltung (Rolle, Deaktivieren/Reaktivieren, Anmeldestatus, Auswahl-Export) sind da; Mail/Einladung an die gefilterte Liste nicht.
- Seitenleiste: Hotkeys-Tab und Admin-Gruppe sind erledigt.

## Seit 2026-10-04 umgesetzt
- **Teilnehmerlimits:** Gesamtlimit plus getrennte Limits für SC und NSC je Event; welche Con-Rollen zählen, ist eine Admin-Einstellung (Standard SC, NSC, Ticket; Crew-Rollen zählen nicht). Warteliste je Limit/Rolle, Rückstufung durch Orga behält die Anmeldezeit (`waitlisted_at`). Admin kann SC auf NSC umstellen (mit Limitprüfung).
- **Anmeldesperre pro Event** (je Con-Rolle und Account-Rolle); wer dadurch warten muss, kommt auf die Warteliste und rückt bei Aufhebung nach.
- **Backup:** Zeitplan-Backup in der App (Admin → Backup → „Automatische Sicherung", siehe `docs/betrieb-backup.md`).
- **Mitglieder:** Konten zusammenführen (Mitglieder-Detail), Mitgliedsnummer, E-Mail änderbar, Mitglieder ohne E-Mail, eingeladene Mitglieder direkt aktivieren, Tabelle sortier- und gruppierbar, Passwort in der App ändern, Add-on „Kinder" für verwaltete Personen.
- **Check-In:** Spalte „Angemeldet am" (auch Mitglieder-Detail und CSV); Admin/Moderator verschieben Unterbringungen (auch im Mitglieder-Detail).
- **Mail:** E-Mail-Vorlagen sind fest einer Mail-Art zugeordnet; Versandprotokoll für Systemmails (90 Tage).
- **Betrieb:** Wartungsseite statt „502 Bad Gateway" während eines Deploys.
- **Zahlungen:** Zahlungsarten einzeln schaltbar, PayPal-Buttons und PayPal.Me, Überweisung melden.
