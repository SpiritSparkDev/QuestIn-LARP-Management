# Betrieb: Verwendungszweck bei Überweisungen

Unter Einstellungen, Zahlung gibt es zwei Vorlagen für den Verwendungszweck (Überweisung und Girocode). Leer = Standard.

| Vorlage | Platzhalter | Standard |
|---|---|---|
| Einzel | `{code}`, `{event}`, `{vorname}`, `{nachname}`, `{name}`, `{rolle}`, `{id}` | `Kennung Vorname-Nachname` |
| Gruppe / Sammelzahlung (Gruppenverwalter) | `{code}`, `{event}`, `{zahler}`, `{gruppe}`, `{personen}`, `{anzahl}`, `{id}` | `{code} {zahler}: {personen}` |

Der Verwendungszweck ist auf höchstens 140 Zeichen begrenzt (Girocode-Grenze).

## Kontoabgleich

Admin (Menü Check-in) lädt einen Kontoauszug hoch; das System ordnet Eingänge offenen Anmeldungen über den Verwendungszweck zu und bucht sie auf Wunsch als bezahlt (wie "Als bezahlt markieren": Zahlungseintrag `bank_transfer`, Audit-Log, Mail).

- **Formate:** CSV (Trennzeichen `;`, `,` oder Tab; Anführungszeichen, BOM, Vorspannzeilen vor der Kopfzeile) CAMT.053-XML (auch mit Namespace-Präfix) und MT940 (`.sta`/`.txt`, erkannt an `:20:`/`:25:`/`:60F:`/`:61:`; Wertstellung/Buchungstag aus `:61:`, nur Gutschriften `C`, Soll `D` und Storno `RC`/`RD` werden ignoriert; strukturiertes `:86:` mit `?20`-`?29` und `?60`-`?63` als Zweck, `?32`/`?33` als Name, Folgezeilen gehören zum Feld, unstrukturiertes `:86:` wird als Freitext-Zweck übernommen). Spalten werden über den Namen gefunden (Betrag/Umsatz/Amount, Verwendungszweck/Buchungstext/Zweck/Reference/Description, Buchungstag/Datum/Valuta, Begünstigter/Zahlungspflichtiger/Auftraggeber/Name). Deutsche Zahlen (`1.234,56`) und Daten (`DD.MM.YY(YY)`) werden verstanden. Nur Gutschriften zählen.
- **Zuordnung:** Der Verwendungszweck des Eingangs muss die erwartete Referenz enthalten (Einzel-Vorlage bzw. Sammelreferenz, Groß-/Kleinschreibung, Leerzeichen und Strich-Varianten egal; Leerzeichen werden beim Vergleich ignoriert, ein von der Bank mitten im Wort eingefügter Umbruch/Leerraum schadet also nicht; bei MT940 werden die festen Zweckzeilen ohne Trennzeichen zusammengesetzt; kein Treffer mitten in einem längeren Wort, "Anna-Muster" trifft nicht "Anna-Mustermann"). Status: `match` (ein Kandidat, Betrag gleich), `amount_mismatch`, `ambiguous` (mehrere Kandidaten mit gleicher Referenz), `duplicate` (Anmeldung schon von einem früheren Eintrag belegt), `unmatched`. Nur offene, zahlbare Anmeldungen (Zahlung freigegeben, nicht bezahlt, Betrag > 0, kein Con-Zahler) sind Kandidaten.
- **Sammelüberweisungen:** Die Referenz wird beim "Überweisung gemeldet" des Gruppenverwalters in `group_payments` (`kind = 'bank'`) gespeichert, mit dem Text, der damals angezeigt wurde. Ändert sich die Vorlage danach, passt die alte Referenz weiter zum bereits überwiesenen Text. Bucht der Eingang, werden alle noch offenen Personen der Auswahl bezahlt.
- **Ablauf:** `POST /admin/bank-reconcile/preview` (schreibt nichts), danach `POST /admin/bank-reconcile/book` mit den bestätigten Einträgen. Gebucht wird nur, wenn der Server den Betrag (Summe der offenen Beträge) neu geprüft hat; wiederholtes Buchen ist harmlos (`already_paid`).
- **Grenzen:** Kein automatisches Buchen ohne Bestätigung. MT940-Subfelder anderer Art (z. B. `?30`/`?31` Bankleitzahl/Konto) werden nicht ausgewertet; ein Zweck, der in anderen Feldern als `?20`-`?29`/`?60`-`?63` steht, wird nicht gefunden (dann manuell buchen). Teilzahlungen, Überzahlungen, Rücküberweisungen und Gutschriften ohne Referenz werden nicht zugeordnet. Maximal 5 MB pro Auszug, 200 Buchungen pro Aufruf.
