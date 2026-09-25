# Admin-definierbare Event-Flags (Sonderrollen) — Design Spec

## 1. Problem

Sonderrollen wie GSC, VP (Vertrauensperson) oder Ersthelfer werden heute
entweder gar nicht abgebildet, oder — wie GSC bis eben — als eigenes,
hartkodiertes Datenbankfeld (`registrations.is_gsc`) plus eigene
Validierungs-/Anzeigelogik. Jede neue Sonderrolle würde eine neue Spalte,
neue Backend-Validierung und neue Frontend-Anzeigefälle erfordern.

Der Nutzer möchte, dass der Admin pro Event beliebig viele solcher
Sonderrollen frei benennen kann (Komma-getrenntes Textfeld), und dass
Teilnehmer bei der Anmeldung ankreuzen können, welche davon auf sie
zutreffen — unabhängig von ihrer SC/NSC-Rolle, mehrere gleichzeitig möglich.
GSC wird dabei zu einer gewöhnlichen Instanz dieses neuen Systems (das
`registrations.is_gsc`-Feld aus der vorangegangenen Iteration wird durch
dieses Spec hinfällig).

## 2. Ziel

- `events.flags text[]` — pro Event frei definierbare Liste von
  Sonderrollen-Namen, admin-editierbar im Event-Formular als
  Komma-getrenntes Textfeld.
- `registrations.flags text[]` — die Teilmenge der Event-Flags, die ein
  Teilnehmer für sich gewählt hat. Unabhängig von `con_role`, mehrere
  gleichzeitig möglich.
- Anmeldeformular zeigt eine Checkbox pro Event-Flag, sobald das gewählte
  Event welche definiert hat — unabhängig davon, ob SC oder NSC gewählt
  ist.
- Flags sind über den bestehenden "Anmeldungsdaten bearbeiten"-Dialog
  (`PUT .../ot-fields`) nachträglich änderbar, inklusive der dort bereits
  vorhandenen E-Mail-Benachrichtigung an Orga/Admin.
- `registrations.is_gsc` entfällt; bestehende GSC-Anmeldungen migrieren
  verlustfrei zu `flags = ARRAY['GSC']`.

## 3. Nicht-Ziel

- Keine Rechte-/Sichtbarkeits-Differenzierung pro Flag (z.B. "nur Orga darf
  X setzen") — jedes definierte Flag ist für jeden Teilnehmer wählbar.
- Keine Icons/Farben/Beschreibungstexte pro Flag — nur ein Name.
- Kein Aufräumen verwaister Werte, falls ein Admin ein Flag aus einem Event
  entfernt, das bereits Teilnehmer gewählt haben — verhält sich wie beim
  Löschen eines Schema-Felds andernorts in dieser App: der Wert bleibt in
  `registrations.flags` liegen, wird nur nicht mehr als wählbare Option
  angezeigt, und eine künftige Validierung akzeptiert ihn nicht mehr als
  neu gesendeten Wert (bestehende Werte werden aber nicht rückwirkend
  geprüft/entfernt).

## 4. Datenmodell

### Migration 044

```sql
ALTER TABLE events ADD COLUMN flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE registrations ADD COLUMN flags text[] NOT NULL DEFAULT '{}';

-- GSC wird ein gewöhnliches Flag statt eines eigenen Feldes: für jedes
-- Event mit mindestens einer is_gsc-Anmeldung wird 'GSC' zur Flag-Liste
-- des Events ergänzt, und jede betroffene Anmeldung bekommt flags=['GSC'].
UPDATE events e SET flags = ARRAY['GSC']
WHERE EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = e.id AND r.is_gsc = true);

UPDATE registrations SET flags = ARRAY['GSC'] WHERE is_gsc = true;

ALTER TABLE registrations DROP COLUMN is_gsc;
```

## 5. Backend

### 5.1 `backend/events/repository.js`

- `SELECT_COLUMNS` ergänzt `flags`.
- `createEvent`/`updateEvent` akzeptieren `flags` (Array von Strings).
  Normalisiert über eine kleine `normalizeFlags(flags)`-Hilfsfunktion:
  trim, leere Strings raus, dedupliziert, Reihenfolge bleibt erhalten.
- `updateEvent`: `flags = COALESCE($n, flags)` — ein explizit gesendetes
  `[]` (leeres Array, kein `null`) löscht alle Flags; ein weggelassenes
  Feld (`undefined` → `null`-Parameter) lässt den bestehenden Wert
  unangetastet. Kein Sonderfall wie bei `capacity`/`clearCapacity` nötig,
  da ein leeres Array (anders als `0`/`""`) nicht mit "weggelassen"
  verwechselt werden kann.

### 5.2 `backend/registrations/repository.js`

- `resolveIsGsc` entfällt, ersetzt durch:
  ```javascript
  // Validiert die gewählten Flags gegen die Flag-Liste des Events und
  // normalisiert auf deren Reihenfolge (dedupliziert nebenbei).
  function resolveFlags(eventFlags, flags) {
    const requested = Array.isArray(flags) ? flags : [];
    const invalid = requested.filter((f) => !eventFlags.includes(f));
    if (invalid.length > 0) {
      const err = new Error(`Unbekannte Flags: ${invalid.join(', ')}`);
      err.code = 'INVALID_FLAG';
      throw err;
    }
    return eventFlags.filter((f) => requested.includes(f));
  }
  ```
- `registerForEvent(userId, eventId, conRole, characterId, nscAvailable, nscCharacterId, flags, otFields, requestingUser)`
  — `isGsc`-Parameter wird zu `flags`; `resolveFlags(event.flags, flags)`
  ersetzt `resolveIsGsc(...)` (kein `conRole`-Gate mehr — Flags sind
  rollenunabhängig, wie besprochen). `INSERT`/`RETURNING` tauschen
  `is_gsc` gegen `flags`.
- `setConRole(...)`: gleiche Umstellung; lädt zusätzlich `event.flags` per
  `getEvent(eventId)` (holt bisher kein Event-Objekt).
- `updateRegistrationOtFields(eventId, userId, otFields, flags)`: neuer
  vierter Parameter. Wenn `flags !== undefined`: `getEvent(eventId)` laden,
  `resolveFlags` aufrufen, `registrations.flags` mit updaten (zusätzliche
  `SET`-Klausel neben dem bestehenden `registration_data_enc`-Update).
  Wenn `undefined`: unverändert lassen (gleiches "nur explizit gesendete
  Felder anfassen"-Muster wie beim Rest dieses Endpunkts).
- `listParticipantsForEvent`, `getScanLookup`, `listRegistrationsForUser`:
  `is_gsc`/`isGsc` durch `flags`/`flags` ersetzt (SELECT + Mapping).

### 5.3 `backend/registrations/routes.js`

- `POST /events/:id/register`: `body.isGsc` → `body.flags`.
- `PUT .../con-role`: `body.isGsc` → `body.flags`.
- `PUT .../ot-fields`: übergibt zusätzlich `body.flags` als vierten
  Parameter an `updateRegistrationOtFields`. `flags` wird in
  `STRUCTURAL_REGISTRATION_KEYS` aufgenommen (immer sichtbar für Staff,
  wie `conRole`/`characterId` — keine `accountFields`-Gate-Prüfung, siehe
  Nicht-Ziel: kein granulares Rechtemodell pro Flag).
- Fehlercode-Mapping: `INVALID_GSC_FLAG` → `INVALID_FLAG` (400) an allen
  drei Routen.

### 5.4 `backend/events/routes.js`

- `POST /events`, `PUT /events/:id`: übernehmen `body.flags` (Array von
  Strings, sonst 400 `"flags must be an array of strings"`).

## 6. Frontend

### 6.1 `frontend/admin/events.html`

- Neues Textfeld "Sonderrollen (Komma-getrennt)" im Event-Formular
  (`z.B. GSC, VP, Ersthelfer`), zwischen Kapazität und Speichern-Button.
- Beim Absenden: `value.split(',').map(s => s.trim()).filter(Boolean)`.
- Beim Bearbeiten: `form.elements.flags.value = eventData.flags.join(', ')`.

### 6.2 `frontend/account.html` — Anmeldeformular

- `gsc-toggle`-Checkbox entfällt.
- Neue Sektion "Sonderrollen" nach dem SC/NSC-Rollenblock, vor "Weitere
  Angaben zu dieser Anmeldung" — unabhängig vom gewählten Rollen-Tab.
  Wird bei jedem `eventSelect`-Change neu gerendert: eine Checkbox pro
  `event.flags`-Eintrag des aktuell gewählten Events; leer/versteckt, wenn
  das Event keine Flags hat.
- Submit: ausgewählte Checkboxen → `flags: [...]` statt `isGsc`.
- `labelForRegisteredAs`: `SC${flags.length ? " (" + flags.join(", ") + ")" : ""}`
  statt der bisherigen `isGsc`-Sonderbehandlung — gilt jetzt auch für NSC/
  Helfer/etc., nicht mehr nur für SC.
- Edit-OT-Dialog (`openEditOtDialog`/Speichern-Handler): rendert zusätzlich
  die Flag-Checkboxen des Events dieser Anmeldung, vorbelegt mit den
  aktuell gesetzten Flags. Sendet `flags` im PUT-Payload nur, wenn sich die
  Auswahl gegenüber dem geladenen Stand geändert hat (gleiches
  "nur geänderte Felder senden"-Muster wie die bestehenden OT-Felder in
  dieser Funktion).

### 6.3 `frontend/admin/checkin.html`

- `isGsc`-Badge-Sonderfall entfällt, ersetzt durch eine generische Schleife
  über `p.flags`/`lookup.flags`, die pro Eintrag einen `<span class="tag">`
  rendert (scan-Dialog-Text und Teilnehmerlisten-Zelle).

## 7. Fehlerbehandlung

- `POST /events`, `PUT /events/:id` mit `flags`, das kein Array (aus)
  Strings ist: 400.
- `POST /register`, `PUT .../con-role`, `PUT .../ot-fields` mit einem Flag,
  das nicht in `event.flags` steht: 400 `INVALID_FLAG`.
- Ein Event ohne Flags: Anmeldeformular zeigt die Sektion einfach nicht;
  kein Sonderfall im Backend nötig (leeres Array ist immer gültig).

## 8. Tests

- `backend/events`: `flags` rundtrip (create/update/clear/get), Ablehnung
  bei Nicht-Array.
- `backend/registrations`: Anmeldung mit gültigem Flag (SC und NSC, zum
  Beleg der Rollenunabhängigkeit), Ablehnung eines unbekannten Flags,
  Mehrfachauswahl, `PUT .../ot-fields` ändert Flags inkl.
  E-Mail-Benachrichtigung (bestehendes Verhalten dieses Endpunkts, jetzt
  auch für Flag-Änderungen).
- Migration: bestehende `is_gsc=true`-Zeile → `flags=['GSC']` +
  `events.flags` enthält `'GSC'`, analog dem Test-Stil vorangegangener
  Spalten-Migrationen dieses Projekts.
- Volle Testsuite (`npm test`) als letzter Schritt des letzten Tasks.

## 9. Migrationsreihenfolge / Risiko

Migration 044 droppt `registrations.is_gsc` (Spalten-Drop, nicht
rückgängig zu machen ohne Backup) — wie bei jeder vorangegangenen
Spalten-Drop-Migration dieses Projekts zuerst gegen die lokale Dev-DB
verifizieren. Migration und alle betroffenen Backend-Konsumenten gehören in
denselben Task.
