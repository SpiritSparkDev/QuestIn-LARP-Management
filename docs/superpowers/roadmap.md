# Roadmap — zurückgestellte Punkte

Punkte aus dem Feature-/UX-Review vom 2026-09-22, die NICHT in die aktuell
beauftragte Umsetzungsreihenfolge (Event-Kapazität/Warteliste,
CSV/Excel-Export, CSV-Import, Bulk-Aktionen, NSC-Dialog, Hotkey-Modifier,
Platzhalter-Hinweise) aufgenommen wurden. Diese sieben Punkte sind inzwischen
umgesetzt (Stand 2026-10-15; die Kapazität inzwischen mit getrennten SC/NSC-Limits). Hier nur gesammelt, nicht
geplant — bei Bedarf eigenes Brainstorming/Spec/Plan pro Punkt.

## Feature

- **Payment-Tracking** — erledigt: Zahlungen (Stripe, PayPal, SumUp,
  Überweisung melden, manuell als bezahlt) samt Protokoll sind umgesetzt,
  siehe `docs/log-ereignisse.md`.

## Technische Schulden / kleine Bugs

- **`events.code` ohne Unique-Constraint, im Admin-Event-Listing nicht
  sichtbar** — Daten-Hygiene-Lücke (kein Sicherheitsproblem, im finalen
  Review der QR-Code-Erfassung-Initiative als non-blocking eingestuft).
- ~~QR-Scanner: `scanDialogAutoCloseId` bei nativem Escape~~ — behoben
  (Version 0.47.1).
- **`db/seedGroups.js` ist seit Migration `014_finalize_group_id.sql`
  faktisch ein No-Op** — Entscheidung nötig: löschen oder bewusst als
  Sicherheitsnetz behalten (im Technische-Schulden-Review explizit als
  Folge-Entscheidung markiert, nicht als Bug).
- ~~`PATCH /account {hotkeys: null}`~~ — behoben (wie „weggelassen" behandelt).

**How to apply:** Vor Beginn eines neuen Punktes hier immer erst gegen den
aktuellen Code verifizieren (Datei/Zeile könnte sich verschoben haben) —
siehe `MEMORY.md`-Hinweis zu veralteten Codezitaten.
