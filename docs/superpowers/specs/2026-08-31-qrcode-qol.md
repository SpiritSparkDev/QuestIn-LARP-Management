# QR-Code Erfassung und QoL

## Kontext
Die App soll in die Lage versetzt werden, bei Check-In QR-Codes per WebCam zu erfassen, um das Check-In zu beschleunigen. Innerhalb der App soll außerdem dokumentiert werden können, welcher Teilnehmer (anhand davon, ob er SC, NSC, sonstiges ist) welche Teilnahmekosten zu tragen hat und ob und wieviel er oder sie bereits gezahlt hat.

## Feature 1: QR-Code Erfassung

### Scan-Modi
Die QR-Code Erfassung soll in den Einstellungen in folgenden Modi verfügbar sein:

**A: Permanent an**
Im "Permanent an" Modus soll die App kontinuierlich über die angeschlossene WebCam nach QR-Codes suchen. Die Scan-Häufigkeit sollte optimiert werden (vorgeschlagen: 1-2 Scans pro Sekunde), um Balance zwischen Reaktionszeit und CPU-Auslastung zu wahren.

**B: 20s-Push-to-See**
Der Benutzer drückt einen Button oder Hotkey. Daraufhin aktiviert sich die Webcam für 20 Sekunden. In dieser Zeit können beliebig viele QR-Codes gescannt werden. Nach 20 Sekunden stoppt die Erfassung automatisch.

**C: Deaktiviert**
Die QR-Scan-Funktion ist ausgeschaltet.

### Performance-Anforderungen
A und B müssen auf ihre Auswirkungen auf die Reaktionszeit der App getestet werden. Zielwert: <100ms Latenz beim Scan bis zur Pop-Up-Anzeige.

### QR-Code Format und Datenfluss

**QR-Code Muster:**
```
P17/2027-[SC/NSC/GSC/ORGA/SL]-[Teilnehmer-ID]
```
- `P17/2027` = Event-Kennzeichnung (ggf. konfigurierbar für andere Events?)
- `[SC/NSC/GSC/ORGA/SL]` = Kategorie des Teilnehmers
- `[Teilnehmer-ID]` = Eindeutige Teilnehmer-ID

### Pop-Up Verhalten nach erfolgreicher Scan

Nach dem Scannen eines gültigen QR-Codes soll folgende Informationen angezeigt werden:
- **OT-Name** (Original-Text des Teilnehmers)
- **IT-Name** (Ingame-Text/Character-Name)
- **Zahlungsstatus**: Bezahlt / Ausstehend / Betrag
- **Kategorie**: SC/NSC/GSC/ORGA/SL

Das Pop-Up sollte folgende Aktionen erlauben:
1. **"Einchecken" Button** oder entsprechender Hotkey → Bestätigt den Check-In
2. **"Abbrechen/Zurück" Button** → Verwirft den Scan

Das Pop-Up sollte nach 30 Sekunden ohne Aktion automatisch schließen oder explizit geschlossen werden können.

### Error Handling
- **Ungültiger QR-Code Format**: Fehlermelding anzeigen, neue Scan ermöglichen
- **Kamera nicht verfügbar/Berechtigung verweigert**: Aussagekräftige Fehlermeldung anzeigen
- **Ungültige Teilnehmer-ID**: Warnung anzeigen, aber Möglichkeit zum manuellen Check-In geben
- **Duplikat-Check-In**: Warnung, wenn Teilnehmer bereits eingecheckt wurde

## Feature 2: Hotkey-Management

### Anforderungen
- In den Einstellungen sollen Hotkeys eine **Default-Zuweisung** bekommen
- Der Benutzer soll Hotkeys **konfigurierbar** machen können
- **Benutzerspezifisch**: Jeder Benutzer erhält eigene Hotkey-Zuweisungen (gespeichert in der Datenbank)
- Default-Hotkeys sollten dokumentiert werden (z.B. Enter = Einchecken, Esc = Abbrechen, Space = QR-Scan starten)

### Scope
Welche Aktionen sollen über Hotkeys verfügbar sein?
- QR-Scan aktivieren (Push-to-See Modus)
- Check-In bestätigen
- Pop-Up schließen
- ggf. weitere?

### Datenspeicherung
Hotkey-Zuweisungen sollten pro Benutzer in der `users`-Tabelle oder in einer separaten `user_hotkeys`-Tabelle gespeichert werden.

## Feature 3: Corporate Identity und Customization

### Anforderungen
Logo und Titel/Name der App sollen für andere Organisationen vom **Admin in den Einstellungen** konfigurierbar sein.

### Customizable Komponenten (MVP)
- **Logo**: Upload/URL für Organisations-Logo
- **Name der Veranstaltung**: Event-Name (z.B. "P17/2027")
- **App-Titel**: Custom-Titel (z.B. "P17 Check-In System")

### Zukünftige Erweiterungen
Diese Funktion könnte in zukünftigen Iterationen erweitert werden um:
- Farbschema/Theme (Branding-Farben)
- Custom CSS/Branding-Elemente
- Multi-Language Support
- Custom Footer/Impressum

## Feature 4: Sichtbarkeit von Auth-Methoden

Falls OAuth-Konfigurationen (Google, Discord, Facebook) nicht korrekt hinterlegt sind, sollen die entsprechenden **Login-Buttons nicht angezeigt** werden.

### Implementierung
- Check bei der Login-Seite: Prüfe `auth.oauthProviders` oder ähnliches
- Nur verfügbare Provider anzeigen

---

## Feature 5: Payment-Tracking (Teil des Kontexts)

### Anforderungen
Innerhalb der App soll dokumentiert werden:
- **Teilnehmer-Kategorie**: SC, NSC, GSC, ORGA, SL (bestimmt die Teilnahmekosten)
- **Fällige Gebühr**: Betrag basierend auf Kategorie
- **Gezahlter Betrag**: Wie viel hat der Teilnehmer bereits bezahlt?
- **Zahlungsstatus**: Offen, Teilzahlung, Bezahlt, Überzahlt

### Integration mit Check-In
Der Zahlungsstatus wird im QR-Code Pop-Up angezeigt und könnte visuell gekennzeichnet sein (z.B. grün=bezahlt, rot=offen, gelb=teilzahlung)

### Datenspeicherung
Sollte in der `registrations`-Tabelle oder separaten `payments`-Tabelle gespeichert werden.

---

## Technische Anforderungen

### Browser/Device-Support
- WebCam-Zugriff erforderlich (WebRTC/getUserMedia API)
- Browser-Kompatibilität: Chrome, Firefox, Safari, Edge (neuere Versionen)
- Mobile: Begrenzte Unterstützung (WebCam auf Smartphones eingeschränkt)

### Performance
- QR-Scan-Latenz: <100ms
- Pop-Up-Response: <200ms
- Keine merkliche CPU/Batterie-Auslastung im "Permanent an" Modus

### Sicherheit
- QR-Codes sollten nur von autorisierten Check-In-Personal lesbar sein
- Duplikat-Check-Ins müssen verhindert/gewarnt werden

---

## Acceptance Criteria

- [ ] QR-Scan funktioniert in allen 3 Modi (Permanent an, Push-to-See, Deaktiviert)
- [ ] Pop-Up zeigt korrekte Teilnehmer-Daten (OT-Name, IT-Name, Zahlungsstatus)
- [ ] Hotkeys sind konfigurierbar pro Benutzer
- [ ] Admin kann Logo und Event-Name ändern
- [ ] Nicht konfigurierte OAuth-Provider sind nicht sichtbar
- [ ] Check-In wird korrekt in der Datenbank gespeichert
- [ ] Performance-Test: <100ms Latenz beim QR-Scan
- [ ] Error-Handling für Kamera-Fehler, ungültige Codes, etc.