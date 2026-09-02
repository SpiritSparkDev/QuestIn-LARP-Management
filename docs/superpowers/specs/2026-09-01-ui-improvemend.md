# UI Verbesserungen

**Version**: 2026-09-01  
**Status**: In Planung  
**Priorität**: Mittel

---

## Bereich Konto und Charaktere

### 1. Awesome-Font Icons verwenden
**Priorität**: Hoch  
**Akzeptanzkriterien**:
- Alle bestehenden Text-Icons durch Font-Awesome Icons ersetzen
- Konsistente Icon-Größen definieren (z.B. 16px, 20px)
- Hover-Effekte (Farb- oder Skalierungseffekt) implementieren
- Icon-Set dokumentieren

### 2. Logout-Button redesignen
**Priorität**: Hoch  
**Akzeptanzkriterien**:
- Button-Element statt Link-Element
- In obere rechte Ecke positionieren
- Rotes/warnendes Styling
- Bestätigungsdialog bei Klick (optional)
- Auf Mobile-Geräten angepasste Größe

### 3. Verschlüsselung-Hinweis mit Icon
**Priorität**: Mittel  
**Details**: Fehlerhafte Feldbezeichnung "Verschüsselt" korrigieren → "Verschlüsselt"  
**Akzeptanzkriterien**:
- Lock-Icon neben verschlüsselten Feldern
- Tooltip mit Erklärung: "Dieses Feld ist verschlüsselt gespeichert"
- Icon-Farbe: Grün oder Blau
- Nur auf Feldern anzeigen, die tatsächlich verschlüsselt sind

### 4. Anordnung Eingabefelder optimieren
**Priorität**: Mittel  
**Akzeptanzkriterien**:
- 1-Spalten Layout auf Mobile, 2-Spalten auf Desktop
- Logische Gruppierung (z.B. Name-Felder zusammen)
- Konsistente Label-Platzierung
- Ausreichend Abstand zwischen Feldern

### 5. Eingabefelder validieren
**Priorität**: Hoch  
**Akzeptanzkriterien**:
- Client-side Validierung implementieren
- Echtzeit-Feedback (rote Borderlinie, Fehlermeldung)
- Required-Felder kennzeichnen (Asterisk oder Icon)
- Validierungsmeldungen aussagekräftig formulieren

---

## Bereich Members

### 1. Pop-Out-Fenster für "Mitglied einladen"
**Priorität**: Mittel  
**Akzeptanzkriterien**:
- Modal-Dialog statt Inline-Bearbeitung
- Formular mit: E-Mail, Gruppenzuweisung, optionale Charakterzuweisung
- Validierung vor dem Senden
- Bestätigungsmeldung nach erfolgreichem Einladen
- Schließen-Button (X) in der rechten oberen Ecke

**Spezifikation (Rollen & Berechtigungen)**:
- Admin kann neue Mitglieder jede beliebige Gruppe zuweisen
- Nur Admins dürfen Gruppen vergeben oder ändern

### 2. Pop-Out-Fenster für "Mitglied bearbeiten"
**Priorität**: Mittel  
**Akzeptanzkriterien**:
- Fenstertyp: Modal-Dialog
- Bearbeitbare Felder: Alle Character-Eigenschaften, E-Mail, Gruppenzugehörigkeit, Status
- Charaktere editierbar machen (separates Pop-Out-Fenster)
- Speichern und Abbrechen Buttons
- Bestätigungsmeldung bei erfolgreicher Änderung

**Speicherverhalten**:
- Änderungen nur nach Klick auf "Speichern"-Button persistent machen
- Warndialog anzeigen, wenn Benutzer die Seite mit ungespeicherten Änderungen verlassen möchte

### 3. Charaktere in "Mitglied bearbeiten" editieren
**Priorität**: Mittel  
**Akzeptanzkriterien**:
- Inline-Liste mit Edit/Delete-Icons
- Neuer Charakter über "+"-Button
- Doppelklick oder Edit-Icon öffnet Character-Pop-Out
- Reihenfolge durch Drag-and-Drop änderbar
- Bestätigung vor Löschen

**Spezifikation**:
- Beliebig viele Charaktere pro Mitglied möglich (keine Beschränkung)
- Alle Character-Eigenschaften sind editierbar

---

## Allgemeine UX-Verbesserungen (zusätzliche Empfehlungen)

### Visual Consistency
- Ein einheitliches Farbschema für alle Bereiche definieren
- Konsistente Button-Stile (Primary, Secondary, Danger)
- Schriftgrößen und Abstände standardisieren

### Accessibility (A11y)
- ARIA-Labels für Screen Reader hinzufügen
- Kontrast-Verhältnis überprüfen (WCAG AA)
- Tastatur-Navigation unterstützen

### Performance
- Icons lazy-loading implementieren
- Modal-Dialoge nur bei Bedarf laden

---

## Abhängigkeiten & Blocker

- [ ] Font-Awesome Installation und Konfiguration
- [ ] CSS-Framework für Modal-Dialoge wählen
- [ ] Validierungs-Bibliothek auswählen (z.B. joi, yup, vee-validate)

---

## Klärungen (✓ Beantwortet)

1. **Welche Character-Eigenschaften sind im "Mitglied bearbeiten"-Dialog editierbar?**
   - ✓ **Antwort**: Alle

2. **Sollen Änderungen automatisch gespeichert werden oder nur nach "Speichern"-Klick?**
   - ✓ **Antwort**: Änderungen nur nach Klick auf "Speichern"-Button. Warndialog wenn eine ungespeicherte Seite verlassen wird.

3. **Maximale Anzahl Charaktere pro Mitglied?**
   - ✓ **Antwort**: Beliebig (keine Beschränkung)

4. **Welche Rollen können Mitglieder haben und wer darf sie vergeben?**
   - ✓ **Antwort**: Neue Mitglieder können vom Admin jede beliebige Gruppe erhalten. Nur Admins können Gruppen vergeben oder ändern.