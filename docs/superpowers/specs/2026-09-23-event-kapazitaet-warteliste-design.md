# Event-Kapazität & Warteliste — Design

**Status:** Approved by user 2026-09-23, ready for plan decomposition.

## Kontext

Erstes Feature einer 7-teiligen, vom Nutzer am 2026-09-22 festgelegten
Umsetzungsreihenfolge (siehe Memory `project_feature_queue_2026_09_22`).
Events haben aktuell keinerlei Teilnehmerzahl-Limit. Dieses Feature führt
ein optionales, pro Event konfigurierbares Kapazitätslimit ein: Anmeldungen
über dem Limit landen auf einer Warteliste statt direkt in den normalen
Freigabe-Flow (`pending → confirmed → checked_in → checked_out`) zu gehen.

## Entscheidungen aus dem Brainstorming

- **Zählbasis:** alle nicht-stornierten Registrierungen zählen gegen das
  Limit — `pending`, `confirmed`, `checked_in`, `checked_out`. `cancelled`
  und `waitlisted` selbst zählen nicht.
- **Nachrücken:** beides möglich, global umschaltbar
  (`app_settings.waitlist_auto_promote`). Ein manueller "Nachrücken"-Button
  bleibt für Staff mit `canOverrideCheckinStatus` unabhängig vom Modus
  immer verfügbar und promoviert eine frei gewählte Person (nicht zwingend
  FIFO) — automatischer Modus promoviert dagegen strikt FIFO
  (`ORDER BY created_at`).
- **Benachrichtigung:** E-Mail sowohl bei "auf Warteliste gesetzt" als auch
  bei "von Warteliste nachgerückt".
- **Sichtbarkeit für Teilnehmer:** nur "Du stehst auf der Warteliste", keine
  Positionsnummer.
- **Nachträgliches Absenken des Limits:** wirkt nur auf neue Anmeldungen ab
  sofort — bereits bestehende Registrierungen (egal welcher Status) werden
  nie automatisch zurückgestuft.
- **Warteliste-UI-Ort für Staff:** `admin/checkin.html`, dieselbe Seite, die
  bereits die Teilnehmerliste mit Status-Override zeigt.

## Datenmodell

Neue Migration `039_event_capacity_waitlist.sql`:

```sql
ALTER TABLE events ADD COLUMN capacity integer;
ALTER TABLE app_settings ADD COLUMN waitlist_auto_promote boolean NOT NULL DEFAULT true;

ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check
  CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'waitlisted'));
```

`capacity` ist NULL = unbegrenzt (Default-Verhalten für alle bestehenden
Events unverändert).

## Statusmaschine

`backend/registrations/statusMachine.js` bekommt einen neuen Eintrag:

```javascript
waitlisted: { cancel: 'cancelled', promote: 'pending' },
```

`waitlisted → pending` (Aktion `promote`) lässt den Datensatz danach exakt
denselben Freigabe-Flow durchlaufen wie jede frisch eingegangene Anmeldung
— keine Sonderbehandlung nötig, sobald der Status wieder `pending` ist.

## Registrierungs-Flow

`backend/registrations/repository.js`, `registerForEvent`:

```javascript
const COUNTED_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out'];
```

Race-sicher via `withTransaction` (bestehender Helfer aus `backend/db.js`,
bisher genutzt für Invitation-Redemption):

1. `SELECT capacity FROM events WHERE id = $1 FOR UPDATE` — sperrt die
   Event-Zeile für die Dauer der Prüfung, serialisiert konkurrierende
   Anmeldungen desselben Events.
2. `SELECT count(*) FROM registrations WHERE event_id = $1 AND status = ANY($2::text[])`
   mit `COUNTED_STATUSES`.
3. `INSERT ... status = (capacity IS NOT NULL AND count >= capacity) ? 'waitlisted' : 'pending'`.

Der bestehende `ALREADY_REGISTERED`-Unique-Constraint-Handler bleibt
unverändert (greift weiterhin bei einem zweiten Insert-Versuch).

## Abmelden von der Warteliste

`unregisterFromEvent`s `DELETE ... WHERE status = 'pending'` wird erweitert
zu `WHERE status IN ('pending', 'waitlisted')` — Verlassen der Warteliste
ist wie bisher bei `pending` ein reines Löschen der Zeile, keine
Status-Transition zu `cancelled`. Löschen einer `waitlisted`-Zeile löst
KEINE Promotion aus (sie zählte nie gegen das Limit).

## Promotion-Logik

Neue Funktion in `backend/registrations/repository.js`:

```javascript
export async function maybePromoteFromWaitlist(eventId) { ... }
```

Ablauf: liest `waitlist_auto_promote` aus `app_settings`; wenn `false`,
sofort zurück (No-Op). Wenn `true`: innerhalb `withTransaction`, sperrt die
Event-Zeile (`FOR UPDATE`) und promoviert in einer Schleife so lange
`waitlisted`-Zeilen (älteste zuerst, `ORDER BY created_at ASC`) via
`applyTransition('waitlisted', 'promote')`, wie `capacity` gesetzt ist UND
die `COUNTED_STATUSES`-Zählung darunter liegt UND noch eine
`waitlisted`-Zeile existiert — **nicht nur eine pro Aufruf**, damit sowohl
"ein Platz frei" (Abmeldung) als auch "mehrere Plätze auf einmal frei"
(Kapazität erhöht) korrekt bedient werden. Verschickt pro promovierter
Person `sendWaitlistPromotedEmail` (fire-and-forget, eigener try/catch, nie
ein 500 — gleiches Muster wie `notifyRegistrationOtFieldsChanged`).

**Aufrufstellen** (jede Stelle, die einen zuvor gezählten Platz freigeben
kann):
- `unregisterFromEvent` — nur wenn die gelöschte Zeile `status = 'pending'`
  war (nicht `waitlisted`, siehe oben).
- `cancelRegistration` (bestehender `POST /events/:id/cancel`,
  Staff-Endpoint) — nach jeder erfolgreichen Transition zu `cancelled`.
- `setStatus` (bestehender `PUT /events/:id/checkin/:userId`,
  Status-Override) — wenn der Zielstatus `cancelled` ist und der vorherige
  Status in `COUNTED_STATUSES` lag.
- **Event-Update** (bestehender `PUT /events/:id`) — wenn `capacity` auf
  einen höheren Wert gesetzt (oder von einem Limit auf `NULL`/unbegrenzt
  geändert) wird, nach dem Speichern aufrufen. Ein gesenktes Limit ruft es
  nicht auf (es gäbe ohnehin nichts zu promovieren).

**Manuelles Nachrücken** (unabhängig vom `waitlist_auto_promote`-Schalter,
immer verfügbar) — **wiederverwendet den bereits existierenden
Status-Override-Mechanismus** (`PUT /events/:id/checkin/:userId` +
`setStatus`), statt einen neuen Endpoint einzuführen: `'waitlisted'` wird
zur bestehenden `VALID_STATUSES`-Liste (Backend) und `STATUS_ORDER`
(Frontend-Dropdown) hinzugefügt, als erstes Element (vor `pending`) — damit
ist `waitlisted → pending` per Index ein "Vorwärts"-Schritt und löst
NICHT den bestehenden Rückwärts-/Skip-Bestätigungsdialog aus, während
`pending → waitlisted` (zurück auf die Warteliste setzen) korrekt als
Rückwärts-Schritt mit Bestätigung behandelt wird. Der bereits vorhandene
per-Zeile-Dropdown erlaubt Staff mit `canOverrideCheckinStatus` damit
schon, jede beliebige wartende Person frei (nicht zwingend FIFO) auf
`pending` zu setzen — kein neuer Button, kein neuer Endpoint nötig.
Einzige Ergänzung: `setStatus`/die Routen-Handler-Funktion verschickt
`sendWaitlistPromotedEmail`, wenn `previousStatus === 'waitlisted' &&
status === 'pending'` war (unconditional, nicht an `waitlist_auto_promote`
gebunden — das ist ja der manuelle, bewusste Staff-Klick).

## Benachrichtigungen

`backend/auth/mailer.js`, gleiches Muster wie
`sendRegistrationOtFieldsChangedEmail` (nimmt ein bereits aufgebautes
`{ transporter, from }`, damit ein Aufrufer mit mehreren Empfängern nicht
pro Mail neu verbindet):

```javascript
export async function sendWaitlistedEmail(to, { eventName }, { transporter, from }) { ... }
export async function sendWaitlistPromotedEmail(to, { eventName }, { transporter, from }) { ... }
```

`registerForEvent` verschickt `sendWaitlistedEmail` fire-and-forget, wenn
das Insert mit `status = 'waitlisted'` erfolgt ist.

## Admin-Einstellungen

`backend/appSettings/repository.js`: `getAppSettings`/`setAppSettings`
bekommen `waitlistAutoPromote` als weiteres Feld. **Wichtig:**
`setAppSettings`s bestehende `COALESCE`-Kette muss `waitlist_auto_promote`
mit aufnehmen — jede Settings-Karte (`PUT`) sendet nur ihre eigenen Felder;
ein fehlendes `COALESCE` würde die anderen beim Speichern stillschweigend
zurücksetzen (siehe Lehre aus dem Einladungslink-Feature, Memory
`project_pakyrion_plan_sequence`).

## UI

- **`frontend/admin/events.html`**: neues optionales Zahlenfeld
  "Max. Teilnehmerzahl" im Event-Formular (leer = unbegrenzt), gespeichert
  über den bestehenden Event-Save-Call.
- **`frontend/admin/settings.html`**: neuer Schalter "Warteliste automatisch
  nachrücken lassen" (bindet an `waitlistAutoPromote`), gleiche Karte/Formular
  wie die übrigen `app_settings`-Toggles.
- **`frontend/admin/checkin.html`**: `waitlisted`-Zeilen erscheinen bereits
  automatisch in der bestehenden Teilnehmerliste (`listParticipantsForEvent`
  liefert sie mit, keine Backend-Änderung an dieser Route nötig) mit einem
  neuen Status-Pill-Label "Warteliste". Der bestehende
  Status-Override-Dropdown (nur für `canOverrideCheckinStatus`-Staff
  sichtbar) bekommt `waitlisted` als Option — Nachrücken ist damit ein
  normaler Dropdown-Wechsel auf "Vorgemerkt", kein neues UI-Element nötig.
- **Teilnehmer-Anmeldestatus** (`frontend/account.html` bzw. wo der
  Registrierungsstatus angezeigt wird): neuer Text für `status ===
  'waitlisted'` → "Du stehst auf der Warteliste."

## Fehlerfälle / Edge Cases

- Zwei gleichzeitige Anmeldungen am letzten freien Platz: durch die
  `FOR UPDATE`-Sperre auf der Event-Zeile serialisiert — die zweite sieht
  den bereits erhöhten Count und landet korrekt auf der Warteliste.
- Event mit `capacity = NULL`: Verhalten identisch zu heute, nie
  `waitlisted`.
- Admin senkt `capacity` unter die aktuelle Zahl: keine automatische
  Rückstufung (siehe Entscheidung oben) — nur neue Anmeldungen betroffen.
- `waitlist_auto_promote = false` und niemand promoviert manuell: Warteliste
  wächst unbegrenzt, kein technisches Problem, reine Orga-Entscheidung.
- E-Mail-Versand schlägt fehl: wird geloggt, ändert nichts am
  HTTP-Response-Status (bestehendes Fire-and-forget-Muster).

## Tests

- Anmeldung unter Kapazität → `pending` (unverändert).
- Anmeldung an/über Kapazität → `waitlisted`.
- Zwei simultane Anmeldungen am letzten Platz → genau eine `pending`, eine
  `waitlisted` (Concurrency-Test, gleiches Muster wie die bestehenden
  Status-Override-Concurrency-Tests).
- Abmelden aus `waitlisted` → Zeile gelöscht, keine Promotion ausgelöst.
- `cancelRegistration`/`setStatus`-Übergang zu `cancelled` bei aktivem
  `waitlist_auto_promote` → älteste `waitlisted`-Person wird `pending`,
  E-Mail-Versand-Aufruf verifiziert (Mock/Spy, wie bei den bestehenden
  Mailer-Tests).
- Gleicher Übergang bei `waitlist_auto_promote = false` → keine Promotion.
- Kapazität wird erhöht (z. B. 30→35) bei 5+ Wartenden und aktivem
  `waitlist_auto_promote` → genau 5 älteste `waitlisted`-Personen werden
  `pending`, Rest bleibt `waitlisted`.
- Manuelles Nachrücken über den bestehenden Override-Endpoint
  (`PUT /events/:id/checkin/:userId` mit `previousStatus: 'waitlisted',
  status: 'pending'`): Erfolg promoviert unabhängig vom Wert von
  `waitlist_auto_promote`; 409 bei gleichzeitiger Statusänderung (bereits
  bestehendes Verhalten); Berechtigungsprüfung (`canOverrideCheckinStatus`
  fehlt → 403, bereits bestehendes Verhalten, nur mit `waitlisted` als
  zusätzlichem Statuswert erneut abgedeckt).
- `setAppSettings`-COALESCE-Regressionstest: `PUT` mit nur
  `{waitlistAutoPromote}` darf `logoUrl`/`appTitle`/`eventName`/etc. nicht
  verändern.
- Voller `npm test`-Lauf als letzter Task-Schritt (Projektstandard).
