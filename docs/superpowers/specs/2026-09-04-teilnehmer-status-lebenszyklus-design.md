# Teilnehmer-Status-Lebenszyklus — Design Spec

## Ziel

Der Teilnehmer-Status je Veranstaltung wird von 3 auf 6 Zustände erweitert, um den
gesamten Lebenszyklus von der Einladung bis zur Absage abzubilden:

```
Benachrichtigt → Vorgemerkt → Angemeldet → Eingechecked → Ausgecheckt
                      ↓             ↓
                  Abgesagt      Abgesagt
```

| Zustand | Bedeutung |
|---|---|
| Benachrichtigt | Die Orga hat eine Einladung für diese Veranstaltung verschickt. Kein Konto/keine Registrierung existiert noch. |
| Vorgemerkt | Registrierung für die Veranstaltung existiert. (Ein Charakter ist in der Praxis meist schon zugeordnet, wird aber erst bei der Freigabe geprüft — siehe unten.) |
| Angemeldet | Die Orga hat die Registrierung freigegeben — entweder nach manueller Bestätigung eines Zahlungseingangs (in diesem Tool nicht abgebildet) oder weil die Person kostenfrei teilnimmt (Orga, Sonderfälle). |
| Eingechecked | Die Person ist vor Ort eingecheckt (unverändert gegenüber heute). |
| Ausgecheckt | Die Person hat ausgecheckt (unverändert gegenüber heute, hieß bisher `checked_out`). |
| Abgesagt | Eine vormals Benachrichtigte/Vorgemerkte/Angemeldete Person hat abgesagt bzw. wurde abgesagt. Terminalzustand, wird als Datensatz erhalten (nicht gelöscht). |

## Bewusste Vereinfachung

"Vorgemerkt" verlangt laut Anforderung sowohl eine Registrierung als auch einen
zugeordneten Charakter. Registrierung und Charakteranlage bleiben aber zwei
unabhängige, in beliebiger Reihenfolge ausführbare Aktionen auf `characters.html`
(unverändert). Statt dies beim Registrieren zu erzwingen, wird die
Charakter-Bedingung **erst bei der Freigabe** (Vorgemerkt → Angemeldet) geprüft:
`registerForEvent` legt weiterhin sofort eine `registrations`-Zeile mit Status
`pending` an, unabhängig davon ob schon ein Charakter existiert. Die Freigabe-Aktion
lehnt ab, wenn für das Event noch kein Charakter existiert.

## Datenmodell

### `registrations.status` (Migration erweitert das bestehende CHECK-Constraint)

Neue interne Enum-Werte (DB/Code bleiben Englisch, konsistent mit dem Bestand):

| Intern | Anzeige (DE) | Ersetzt |
|---|---|---|
| `pending` | Vorgemerkt | vormals `registered` |
| `confirmed` | Angemeldet | (neu) |
| `checked_in` | Eingechecked | unverändert |
| `checked_out` | Ausgecheckt | unverändert |
| `cancelled` | Abgesagt | (neu) |

Migration:
```sql
ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check
  CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'));
UPDATE registrations SET status = 'pending' WHERE status = 'registered';
ALTER TABLE registrations ALTER COLUMN status SET DEFAULT 'pending';
```
(Der genaue Name des bestehenden CHECK-Constraints wird beim Schreiben des Plans
per `\d registrations` in der Zieldatenbank verifiziert — Postgres vergibt
Default-Namen wie `registrations_status_check`, aber das muss vor dem Schreiben
der Migration bestätigt werden, nicht angenommen.)

`checked_in`/`checked_out`-Zeilen bleiben unverändert; nur `registered` wird
umbenannt, und zwei neue Endzustände (`confirmed`, `cancelled`) kommen hinzu.

### `invitations.event_id` (neue Spalte, nullable)

```sql
ALTER TABLE invitations ADD COLUMN event_id uuid REFERENCES events(id);
```
Nullable, damit bestehende Einladungen (ohne Veranstaltungsbezug) gültig bleiben.
Ab sofort verlangt `POST /members/invite` `eventId` als Pflichtfeld für neue
Einladungen (Validierung auf Route-Ebene, nicht per NOT NULL-Constraint, damit
Altdaten nicht brechen).

### "Benachrichtigt" ist kein gespeicherter Status

Eine "Benachrichtigt"-Zeile in der Teilnehmerliste ist kein `registrations`-Datensatz,
sondern eine `invitations`-Zeile mit gesetztem `event_id`, für die noch **keine**
`registrations`-Zeile existiert. Sobald die Einladung eingelöst wird, entsteht
dadurch noch **keine** Registrierung — die eingeladene Person muss sich (wie ein
Self-Signup, der nie eingeladen wurde) separat auf `characters.html`
registrieren. Erst dann verschwindet der "Benachrichtigt"-Eintrag und ein
"Vorgemerkt"-Eintrag erscheint. Ein rein selbst-registrierter Teilnehmer ohne
jede Einladung durchläuft "Benachrichtigt" nie — er startet direkt bei
"Vorgemerkt", sobald er sich registriert.

Abfrage (Skizze, für `listParticipantsForEvent`):
```sql
SELECT i.id, i.email, i.first_name, i.last_name, i.nickname
FROM invitations i
LEFT JOIN users u ON u.email = i.email
LEFT JOIN registrations r ON r.user_id = u.id AND r.event_id = i.event_id
WHERE i.event_id = $1
  AND r.user_id IS NULL
  AND (i.redeemed_at IS NOT NULL OR i.expires_at > now())
```
Der `expires_at`-Check gilt nur für noch nicht eingelöste Einladungen (eine
abgelaufene, nie eingelöste Einladung soll nicht dauerhaft als "Benachrichtigt"
in der Liste hängen bleiben); für bereits eingelöste ist `expires_at` irrelevant.

## Zustandsübergänge

```javascript
const TRANSITIONS = {
  pending:    { approve: 'confirmed', cancel: 'cancelled' },
  confirmed:  { checkin: 'checked_in', cancel: 'cancelled' },
  checked_in: { checkout: 'checked_out' },
  checked_out: {},
  cancelled:  {},
};
```

- `approve` (Freigeben): NEU. Nur zulässig, wenn für den Teilnehmer im Event
  bereits mindestens ein Charakter existiert — sonst 409 mit klarer
  Fehlermeldung ("kein Charakter zugeordnet"). Setzt `confirmed_at`.
- `cancel` (Absagen): NEU. Zulässig aus `pending` und `confirmed`.
- Absage einer offenen Einladung (Benachrichtigt, keine `registrations`-Zeile):
  eigener Pfad, siehe unten — erzeugt eine `registrations`-Zeile direkt mit
  Status `cancelled` und entwertet die Einladung (`expires_at` auf `now()`
  setzen, damit der Token nicht mehr einlösbar ist — kein neues Feld nötig).
- `checkin`/`checkout` unverändert, außer der Vorbedingung: `checkin` verlangt
  jetzt `confirmed` statt `registered`.

## Berechtigungen

Freigeben und Absagen (aus `pending`/`confirmed`) laufen über dieselbe
bestehende Berechtigung wie der heutige manuelle Status-Override:
`user.group.canOverrideCheckinStatus`, unter `requireMenu('checkin')`. Kein
neues Rechte-Flag.

Absagen einer offenen Einladung (Benachrichtigt) läuft über die bestehende
Mitgliederverwaltungs-Berechtigung (`requireMenu('mitglieder')`), da
Einladungen bereits dort verwaltet werden (`admin/members.html`).

## Backend-Änderungen

### `backend/registrations/statusMachine.js`
`TRANSITIONS` wie oben. `applyTransition` bleibt unverändert (generische
Lookup-Funktion, kein Sonderfall nötig).

### `backend/registrations/repository.js`
- `registerForEvent`: Status-Default ändert sich implizit durch die neue
  Spalten-Default (`pending` statt `registered`), kein Code-Change nötig.
- `unregisterFromEvent`: Bedingung `status = 'registered'` → `status = 'pending'`.
- Neue Funktion `approveRegistration(eventId, userId)`: prüft Charakter-Existenz
  (`SELECT 1 FROM characters WHERE event_id = $1 AND user_id = $2 LIMIT 1`),
  wirft `NO_CHARACTER` wenn leer, sonst `transitionStatus(eventId, userId, 'approve')`.
- Neue Funktion `cancelRegistration(eventId, userId)`: `transitionStatus(eventId, userId, 'cancel')`.
- Neue Funktion `cancelInvitation(invitationId)`: in einer Transaktion — Charakterdaten
  der Einladung lesen, `registrations`-Zeile mit Status `cancelled` für
  `(invitedUserPlaceholder, eventId)` anlegen — **offene Frage für den Plan:**
  da zu diesem Zeitpunkt noch kein `user_id` existiert (keine Registrierung
  ohne Konto), muss geklärt werden, ob `registrations.user_id` dafür nullable
  werden muss, oder ob eine separate `cancelled_invitations`-Ablage sauberer
  ist. Der Plan entscheidet das anhand des tatsächlichen Schemas
  (`registrations.user_id` ist heute `NOT NULL`) — vermutlich braucht es eine
  eigene, schlanke Tabelle statt `registrations.user_id` nullable zu machen.
- `listParticipantsForEvent`: muss zusätzlich offene, event-gebundene
  Einladungen ohne zugehörige Registrierung laden und als synthetische Zeilen
  (`status: 'notified'`, kein `userId`, stattdessen `invitationId`) anhängen.
  `'notified'` ist nur ein Anzeige-Statuswert für die API-Antwort, kein
  `registrations.status`-Enum-Wert.

### `backend/registrations/routes.js`
- `router.post('/events/:id/approve', ...)` (neu, `canOverrideCheckinStatus`).
- `router.post('/events/:id/cancel', ...)` (neu, `canOverrideCheckinStatus`,
  Body `{ userId }`).
- `VALID_STATUSES` in der bestehenden Override-Route (`PUT
  /events/:id/checkin/:userId`) erweitert um `pending`, `confirmed`, `cancelled`.
- `checkin`-Route: Fehlermeldung bei `INVALID_TRANSITION` bleibt wie heute
  (generisch), keine Änderung nötig — die Vorbedingung ändert sich implizit
  durch die neue TRANSITIONS-Tabelle.

### `backend/invitations/repository.js` / `backend/members/routes.js`
- `createInvitation` erhält `eventId`, INSERT-Spaltenliste erweitert.
- `POST /members/invite` verlangt `eventId`, validiert gegen `events`-Tabelle
  (analog zur bestehenden Gruppen-Validierung).
- Neue Route `router.post('/members/invitations/:id/cancel', ...)`
  (`requireMenu('mitglieder')`) ruft `cancelInvitation` auf.

## Frontend-Änderungen

### `frontend/admin/checkin.html`
- `STATUS_LABELS` erweitert: `{ notified: 'Benachrichtigt', pending: 'Vorgemerkt', confirmed: 'Angemeldet', checked_in: 'Eingechecked', checked_out: 'Ausgecheckt', cancelled: 'Abgesagt' }`.
- `STATUS_ORDER` (für den Override-Select) erweitert entsprechend, `notified`
  ausgeschlossen (kein echter `registrations.status`, kein Override möglich).
- Zeilen mit `status === 'notified'` bekommen abweichende Aktionen: kein
  Check-in/Check-out/Override, stattdessen ein "Absagen"-Button (ruft die neue
  Invitations-Cancel-Route auf).
- Zeilen mit `pending` bekommen einen "Freigeben"-Button (ruft `/events/:id/approve`
  auf, zeigt die 409-Fehlermeldung bei fehlendem Charakter direkt in `message`
  an) und einen "Absagen"-Button (`/events/:id/cancel`).
- Zeilen mit `confirmed` behalten Check-in wie heute, plus "Absagen".
- `renderOverrideCell`/`STATUS_ORDER`: `cancelled` ans Ende, kein Rücksprung
  aus `cancelled` erlaubt (matches `TRANSITIONS`).

### `frontend/css/everest-registry.css`
Neue Status-Pill-Farben für `.status-notified`, `.status-pending`,
`.status-confirmed`, `.status-cancelled` (Farbschema analog zu den
bestehenden drei — die aktuellen CSS-Variablen `--registered`/`--checked-in`/
`--checked-out` werden beim Schreiben des Plans an die live editierte Datei
angepasst, da eine parallele Session die Admin-Theme-Farben gerade überarbeitet;
der Plan liest die Datei frisch statt die Werte aus diesem Spec zu übernehmen).

### `frontend/admin/members.html`
Invite-Dialog bekommt ein Event-Auswahlfeld (Pflichtfeld), analog zum
bestehenden Gruppen-Select. Events werden wie auf `characters.html` per
`api.get('/events')` geladen.

## Migration / Rollout

1. Migration fährt `registered` → `pending` für alle Bestandsdaten (siehe oben)
   — die Orga muss anschließend jede bestehende Registrierung einmal manuell
   freigeben.
2. Bestehende `invitations`-Zeilen ohne `event_id` bleiben nutzbar (Redemption
   unverändert), erscheinen aber in keiner Teilnehmerliste als "Benachrichtigt"
   (da diese Ansicht `event_id IS NOT NULL` voraussetzt).

## Offene Punkte für den Implementierungsplan

1. Exakter Name des bestehenden `registrations`-Status-CHECK-Constraints (per
   `\d registrations` verifizieren, nicht annehmen).
2. Speicherform für "abgesagte Einladung ohne Konto" (siehe
   `cancelInvitation` oben) — vermutlich eigene schlanke Tabelle statt
   `registrations.user_id` nullable zu machen; endgültige Entscheidung beim
   Planschreiben anhand des tatsächlichen Schemas.
3. Aktuelle Farbwerte für die neuen Status-Pills — aus der zum Planzeitpunkt
   aktuellen `everest-registry.css` übernehmen, nicht aus diesem Dokument.
