# Roadmap — zurückgestellte Punkte

Punkte aus dem Feature-/UX-Review vom 2026-09-22, die NICHT in die aktuell
beauftragte Umsetzungsreihenfolge (Event-Kapazität/Warteliste,
CSV/Excel-Export, CSV-Import, Bulk-Aktionen, NSC-Dialog, Hotkey-Modifier,
Platzhalter-Hinweise) aufgenommen wurden. Hier nur gesammelt, nicht
geplant — bei Bedarf eigenes Brainstorming/Spec/Plan pro Punkt.

## Feature

- **Payment-Tracking** — ursprünglich Feature 5 im Erst-Spec
  (`docs/superpowers/specs/2026-08-24-teilnehmerregistrierung-design.md`),
  nie begonnen, weiterhin offen.

## Technische Schulden / kleine Bugs

- **`events.code` ohne Unique-Constraint, im Admin-Event-Listing nicht
  sichtbar** — Daten-Hygiene-Lücke (kein Sicherheitsproblem, im finalen
  Review der QR-Code-Erfassung-Initiative als non-blocking eingestuft).
- **QR-Scanner: `scanDialogAutoCloseId` wird bei nativem Escape nicht
  gecancelt** — ein stehender 30s-Timer kann einen später geöffneten
  Scan-Dialog zu früh schließen (seit QR-Code-Erfassung-Plan offen,
  eigenständig fixbar).
- **`db/seedGroups.js` ist seit Migration `014_finalize_group_id.sql`
  faktisch ein No-Op** — Entscheidung nötig: löschen oder bewusst als
  Sicherheitsnetz behalten (im Technische-Schulden-Review explizit als
  Folge-Entscheidung markiert, nicht als Bug).
- **`PATCH /account {hotkeys: null}`** speichert ein echtes JSONB-`null`
  statt es wie jedes andere Feld als "weggelassen" zu behandeln —
  niedriges Risiko, aktuell kein Aufrufer betroffen.

**How to apply:** Vor Beginn eines neuen Punktes hier immer erst gegen den
aktuellen Code verifizieren (Datei/Zeile könnte sich verschoben haben) —
siehe `MEMORY.md`-Hinweis zu veralteten Codezitaten.
