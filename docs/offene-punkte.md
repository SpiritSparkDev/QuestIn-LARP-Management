# Offene Punkte (Stand 2026-10-04)

Entscheidungen zur Fragenliste: Wo nichts anderes gesagt wurde, gilt die jeweilige Empfehlung.

## Entschieden
- **Tavernenkonto:** Kein Online-Aufladen (Stripe/PayPal) durch Gäste. Kein Dispo, Konten werden hart gesperrt, wenn das Guthaben nicht reicht. Umgesetzt werden Tagesabrechnung, CSV-Export der Buchungen und die Buchungsart "Auszahlung" (Restguthaben) mit Hinweis in der Kasse.
- **PDF-Import:** Pro Event voraussichtlich nur eine Vorlage. Gruppen-PDFs sind nicht vorgesehen (keine Übernahme als verwaltete Personen). Die Einverständniserklärung muss einem PDF-Feld zugeordnet sein, sonst lehnt die Übernahme ab.
- **Test-Modus:** Bleibt wie er ist, keine zusätzliche Absicherung auf Produktivservern.
- **Charaktere in fremden Accounts anlegen:** Weiterhin nur Admin und Moderator (fest im Code); ein Gruppenrecht erst, wenn es gebraucht wird.
- **Staff-Felder an eigenen Charakteren:** Erlaubt, aber mit Protokoll (wer hat wann welches Feld geändert).
- **CSV-Export:** Jeder Export wird protokolliert; sensible Felder (z. B. Gesundheitshinweise) nur mit eigenem Recht. Eine CSV der Check-In-Liste kommt dazu.

## Zurückgestellt (bewusst nicht jetzt umsetzen)
13. **Echtgeräte-Test:** Check-In mit QR-Scan und Taverne einmal auf einem echten Handy ausprobieren, vor dem nächsten Con. (Bisher nur simulierte Geräte.)
14. **Mobile Prüfung:** Event-Bearbeitung, Charakter-Bearbeitung und das Mitglieder-Fenster wurden noch nicht im Handy-Format durchgesehen.
15. **Check-In ohne aktives Event:** Das Event-Dropdown ist leer. Idee: Hinweis mit Link zu "Events" statt leerer Seite.
16. **Migrationen:** Es gab ein doppeltes Präfix `067` (Stripe-Überweisung und meine CSV-Migration). Meine ist inzwischen `070_group_can_export_members.sql`. Prüfen, ob auf den Servern `067` bis `069` in anderer Reihenfolge gelaufen sind; `npm run migrate` wendet alle noch fehlenden Dateien nach Namen an.
17. **Webhook:** Der Test-Push zeigte HTTP 404 auf `/api/stacks/webhooks/…` (Deploy-Hook). Ursache offen (falsche/erneuerte Webhook-ID, Stack neu angelegt, Endpoint nimmt `ping` nicht an).

## Ideen ohne Entscheidung
- Event-Anmeldung als Mitglieder-Filter ist da; Massenaktionen (Mail/Einladung an die gefilterte Liste) nicht.
- Seitenleiste: Hotkeys-Tab und Admin-Gruppe sind erledigt.
