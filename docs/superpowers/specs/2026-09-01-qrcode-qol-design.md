# QR-Code-Erfassung und QoL — Design

**Status:** Approved by user 2026-09-01, ready for plan decomposition. Feature 5 (Payment-Tracking) explicitly deferred, out of scope for this initiative.

## Kontext

Ausgangsspec: `docs/superpowers/specs/2026-08-31-qrcode-qol.md` (User-verfasst, beschreibt 5 Features). Während der Klärung stellte sich heraus, dass die Spec nur das SCANNEN von QR-Codes beschreibt, nicht deren Herkunft — die App muss QR-Codes also auch selbst generieren und den Teilnehmern anzeigen, nicht nur lesen können.

**Umfang dieser Initiative:** Features 1–4 der Ausgangsspec. Feature 5 (Payment-Tracking) bleibt bewusst außen vor.

**Reihenfolge (jeder Teil ein eigener Plan):** 1 → 2 → 3 → 4. Plan 4 (Hotkeys) hängt vom Scan-Popup aus Plan 3 ab, sonst sind alle Teile unabhängig.

---

## Plan 1: OAuth-Provider-Sichtbarkeit

Kleinstes, unabhängiges Stück.

### Backend
Neue öffentliche (unauthentifizierte) Route `GET /auth/oauth/providers` in `backend/auth/oauth.js`, iteriert über `PROVIDERS` (aus `backend/auth/oauthProviders.js`) und gibt für jeden Key zurück, ob sowohl `clientId()` als auch `clientSecret()` einen Wert liefern:
```json
{ "google": true, "facebook": false, "discord": true }
```
Keine Secrets, keine URLs — nur Booleans.

### Frontend
`frontend/login.html`: die drei fest verdrahteten OAuth-Links (`Google`/`Facebook`/`Discord`, aktuell Zeilen 28-31) werden beim Laden gegen `GET /auth/oauth/providers` geprüft; ein nicht konfigurierter Provider wird per `style.display = 'none'` ausgeblendet, nicht aus dem DOM entfernt (einfacher als bedingtes Rendering, gleiche Praxis wie an anderen Stellen dieses Projekts).

---

## Plan 2: Corporate Identity / Branding

### Datenmodell
Neue Migration, neue Single-Row-Tabelle `app_settings` (gleiches Muster wie `smtp_settings`/`nsc_profile_schema`: `SELECT ... LIMIT 1`, insert-or-update in der Repository-Schicht, kein DB-Singleton-Trick):
```sql
CREATE TABLE app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logo_url text,
  app_title text,
  event_name text
);
```
Leere Tabelle zu Beginn — jede Konsumenten-Seite fällt auf hartcodierte Defaults ("Pakyrion", kein Logo) zurück, wenn keine Zeile existiert.

### Backend
`backend/appSettings/repository.js` + `backend/appSettings/routes.js`, admin-only via `requireAdminGroup` für `PUT`, aber `GET /app-settings` ist **öffentlich** (unauthentifiziert) — jede Seite inkl. der Login-Seite braucht die Branding-Daten, bevor überhaupt eine Session existiert.

### Frontend
Neue Admin-Seite `frontend/admin/branding.html` (analog zu `admin/settings.html`), Nav-Link nach demselben hartcodierten `admin`-Muster wie „Gruppen"/„Einstellungen".

**Blast Radius, bewusst in Kauf genommen:** jede der ~15 bestehenden HTML-Seiten hat „Pakyrion" hartcodiert im `<title>` und in einem `.brand-name`/`.sidebar-brand`-Element. Statt serverseitigem Templating einzuführen (widerspräche dem „kein Build-Step"-Prinzip dieses Projekts), bekommt jede Seite ein neues, gemeinsames `frontend/js/branding.js`:
```javascript
export async function applyBranding() {
  const res = await fetch('/app-settings');
  if (!res.ok) return;
  const settings = await res.json();
  if (settings.appTitle) document.title = document.title.replace('Pakyrion', settings.appTitle);
  const brandName = document.querySelector('.brand-name, .sidebar-brand');
  if (brandName && settings.appTitle) {
    // .sidebar-brand has a nested <span>Admin</span> that must survive
    const span = brandName.querySelector('span');
    brandName.childNodes[0].textContent = settings.appTitle;
    if (span) brandName.appendChild(span);
  }
  if (settings.logoUrl) {
    const seal = document.querySelector('.brand-seal');
    if (seal) seal.innerHTML = `<img src="${settings.logoUrl}" alt="Logo">`;
  }
}
```
Jede Seite ruft `applyBranding()` einmal beim Laden auf (ein Import + ein Aufruf pro Datei — mechanische Änderung an ~15 Dateien, exakter Musterrule + ein vollständig ausgearbeitetes Beispiel pro Themen-Datei beim Plan-Schreiben, analog zum bewährten Vorgehen aus der Technische-Schulden-Plan).

**Logo bewusst nur als URL-Feld**, kein Datei-Upload — die generische Upload-Infrastruktur (Plan 5 der laufenden Mitgliederfelder-Initiative) existiert noch nicht; das als Abhängigkeit vorauszusetzen wäre eine unnötige Kopplung. Kann später nachgezogen werden.

---

## Plan 3: QR-Code-Erfassung

Der größte Teil dieser Initiative.

### Datenmodell
Migration fügt `events.code text` hinzu (nullable — ein Event ohne gesetzten Code hat schlicht keinen gültigen QR-Code, kein Zwang, ihn zu setzen).

### QR-Encoding/-Decoding: externe Bibliotheken per CDN, nicht vendored
Es gibt keine native Browser-API zum ERZEUGEN von QR-Codes (nur `BarcodeDetector` fürs Lesen, und selbst das nicht in Firefox/Safari — die Spec fordert aber genau diese Browser). Einen QR-Codec von Hand zu schreiben ist nicht praktikabel. **Abweichung von der Chat-Zusammenfassung:** statt die Bibliotheken als lokale statische Dateien zu vendoren, werden sie exakt wie die bereits in jeder Seite verwendeten Google-Fonts per `<script src="https://cdn.jsdelivr.net/...">`-Tag eingebunden — das ist konsistent mit dem bereits etablierten Muster dieses Projekts (externe CDN-Ressource per Tag, kein npm, kein Build-Step) und vermeidet den unpraktikablen Versuch, komplexen Bibliothekscode von Hand in einen Implementierungsplan zu reproduzieren:
- Encoding (Generierung): `qrcode-generator` (kazuhikoarase, MIT, reines JS, keine Abhängigkeiten) — `https://cdn.jsdelivr.net/npm/qrcode-generator@1/qrcode.min.js`
- Decoding (Scannen): `jsQR` (ISC, reines JS, keine Abhängigkeiten) — `https://cdn.jsdelivr.net/npm/jsqr@1/dist/jsQR.js`

### QR-Code-Format
`{eventCode}-{groupKey}-{userId}`, z.B. `P17/2027-sc-a1b2c3d4-...`. `groupKey` ist die eigene Gruppe des Nutzers zum Zeitpunkt der Anzeige (nicht die Charakterklasse) — Check-In erfolgt pro Person, nicht pro Charakter, und die Gruppen-Keys (`sc`/`nsc`/`gsc`/`orga`/`sl`) decken exakt die in der Ausgangsspec genannten Kategorien ab (minus `admin`/`plot_orga`/`hilfs_sl`, die dort nicht vorkommen, aber technisch genauso funktionieren würden).

### Generierung — Konto-Seite
`frontend/account.html` bekommt einen neuen Abschnitt: QR-Code für das **aktuell aktive Event**, aber nur falls der Nutzer dafür angemeldet ist (`GET /registrations` bereits vorhanden, liefert Status pro Event). Kein aktives Event oder keine Anmeldung → erklärender Hinweistext statt QR-Code, kein Fehler. Rendering: ein `<canvas>`, befüllt über `qrcode-generator`s Standard-API.

### Scannen — Check-In-Seite
`frontend/admin/checkin.html` bekommt einen neuen Abschnitt „QR-Scan" mit:
- Modus-Auswahl (Permanent an / 20s-Push-to-See / Aus) — rein clientseitig in `localStorage` gespeichert, kein Server-Sync (persönliche UI-Einstellung, kein Bedarf für geräteübergreifende Synchronisation).
- `<video>`-Element für den Kamera-Feed (`getUserMedia`), ein `<canvas>` (unsichtbar) für Frame-Grabs, die per `jsQR` dekodiert werden.
- Bei erkanntem, valide geformtem Code (`eventCode-groupKey-userId`, `eventCode` muss zum aktuell ausgewählten Event passen): neue Lookup-Route `GET /events/:eventId/scan-lookup?code=...` (siehe unten) auflösen, Pop-up mit den Daten zeigen.
- Pop-up-Aktionen: „Einchecken" (ruft die BESTEHENDE `POST /events/:id/checkin`-Route mit der aufgelösten `userId` auf — keine neue Check-In-Logik, volle Wiederverwendung), „Abbrechen" (verwirft, Scan geht weiter). Automatisches Schließen nach 30s Inaktivität.

### Neue Route: `GET /events/:eventId/scan-lookup?code=...`
`requireAuth(requireMenu('checkin')(...))`, gleiche Berechtigung wie die bestehende Teilnehmerliste. Parst `code` in `eventCode`/`groupKey`/`userId`; 400 bei Format-Fehler; 400 falls `eventCode` nicht zum in der URL angegebenen `:eventId` passt (verhindert, dass ein Code von Event A bei Event B eingecheckt wird); 404 falls keine Registrierung für diesen `userId`+`eventId` existiert. Erfolgsfall gibt zurück:
```json
{
  "userId": "...",
  "name": "...",
  "group": "sc",
  "status": "registered",
  "characters": [{ "id": "...", "name": "..." }]
}
```
(`characters` als Array, nicht einzelnes „IT-Name"-Feld — ein Nutzer kann laut bestehendem Datenmodell mehrere SC-Charaktere pro Event haben, „Ersatzcharaktere"; das Pop-up zeigt alle. `status` erlaubt der Check-In-Seite, VOR dem Bestätigen eine Warnung zu zeigen, falls bereits eingecheckt — deckt den in der Ausgangsspec geforderten Duplikat-Check-In-Hinweis ab, ohne die bestehende, bereits nebenläufigkeitssichere `checkIn()`-Funktion zu duplizieren.)

### Performance
Scan-Intervall im „Permanent an"-Modus: 750ms (Mittelwert des in der Spec vorgeschlagenen 1-2 Scans/Sekunde). Kein serverseitiger Aufwand pro Scan-Versuch — Dekodierung passiert vollständig clientseitig via `jsQR`; die Lookup-Route wird nur bei einem tatsächlich erkannten Code aufgerufen, nicht pro Frame.

---

## Plan 4: Hotkey-Management

Baut auf Plan 3s Scan-Pop-up auf.

### Datenmodell
Migration fügt `users.hotkeys jsonb not null default '{}'` hinzu (passt zum bestehenden Muster flexibler JSONB-Spalten für Nutzer-Konfiguration, z.B. dem früheren `nsc_data`).

### Backend
`PATCH /account` (bereits vorhanden, nimmt beliebige Felder aus dem Body) bekommt ein neues, ungegatetes Feld `hotkeys` — genau wie `firstName`/`lastName` heute schon ungegatet sind, da es reine Selbstverwaltung ist.

### Frontend
Konfiguration direkt auf `admin/checkin.html` (nicht auf der allgemeinen Konto-Seite) — Hotkeys sind nur im Check-In-Kontext relevant. Default-Zuweisungen (aus der Ausgangsspec): `Enter` = Einchecken (im offenen Pop-up), `Escape` = Abbrechen/Pop-up schließen, `Leertaste` = QR-Scan starten (nur im Push-to-See-Modus sinnvoll). Ein `keydown`-Listener auf Dokumentenebene, gated auf „Pop-up ist offen" bzw. „kein Eingabefeld hat gerade Fokus" (verhindert, dass Hotkeys feuern, während z.B. die Event-Auswahl den Fokus hat).

---

## Selbst-Review

- **Platzhalter-Scan:** keine TBD/TODO; jede neue Route/Tabelle/Spalte ist konkret benannt.
- **Interne Konsistenz:** Plan 3s QR-Format (`eventCode-groupKey-userId`) wird in Generierung (Plan 3, Konto-Seite) und Scannen (Plan 3, Check-In-Seite) identisch verwendet. Plan 4s Hotkeys setzen exakt das in Plan 3 gebaute Pop-up voraus (Einchecken/Abbrechen-Aktionen existieren dort bereits als klickbare Buttons, Hotkeys rufen dieselben Handler auf).
- **Scope-Check:** vier klar geschnittene Pläne, jeder für sich lauffähig/testbar; einzige echte Abhängigkeit ist 4 auf 3.
- **Mehrdeutigkeits-Check:** „Kategorie" im QR-Code wurde als Gruppen-Key (nicht Charakterklasse) festgelegt, da Check-In pro Person, nicht pro Charakter erfolgt — explizit begründet, nicht stillschweigend angenommen. Logo-Feld bewusst auf URL beschränkt (kein Upload), mit Begründung.
