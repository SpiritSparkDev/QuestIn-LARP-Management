# Verwaltete Personen (Mehrpersonen-Anmeldung) — Design Spec

## 1. Problem

Heute kann sich nur anmelden, wer selbst einen Account mit Login hat
(Passwort oder OAuth). Für Gruppen und besonders für Teilnehmer mit
Kindern ist das unpraktisch: nicht jede mitfahrende Person kann oder will
sich selbst einloggen, soll aber trotzdem einen eigenen Charakter, eine
eigene Anmeldung und eigene Mitgliedsdaten (inkl. Notfallkontakt) haben —
kein reines Namensfeld an der Anmeldung des Haupt-Accounts.

Es existiert bereits ein verwandter Mechanismus: Gast-Accounts
(`users.is_guest`, eingeführt in Migration 046 für das externe
Ticket-Widget) sind ganz normale `users`-Zeilen ohne `password_hash`, die
sich nie selbst einloggen können, aber ansonsten wie jeder Account
Charaktere/Anmeldungen/Mitgliedsdaten haben und später per Invitation in
einen echten Account "umgewandelt" werden können
(`backend/members/routes.js`'s `generate-conversion-link`). Dieses Spec
erweitert genau diesen Mechanismus, statt eine neue Parallelstruktur zu
bauen.

## 2. Ziel

- Jeder eingeloggte, nicht-Gast-Account kann eigene "verwaltete Personen"
  anlegen, bearbeiten und für Events anmelden — ohne Admin-Umweg.
- Eine verwaltete Person ist eine gewöhnliche `users`-Zeile
  (`is_guest=true`, `password_hash=NULL`), zusätzlich markiert über
  `managed_by_user_id`, dauerhaft im Haupt-Account verwaltet (wiederver-
  wendbar über mehrere Events).
- Verwaltete Personen bekommen volle Mitgliedsdaten (verschlüsselte Felder
  wie beim Haupt-Account) und landen standardmäßig in derselben Gruppe wie
  der Haupt-Account.
- Der Haupt-Account kann für eine verwaltete Person Charaktere anlegen,
  sie für Events an-/abmelden und — falls ein Betrag fällig ist — direkt
  eingeloggt bezahlen (keine Weiterleitung über den E-Mail-Zahlungslink
  des anonymen Gast-Flows).
- Eine verwaltete Person kann jederzeit per Link in einen echten,
  unabhängigen Account umgewandelt werden (self-service, analog zur
  bestehenden Admin-Funktion); danach verliert der Haupt-Account jeden
  Zugriff.
- Eine verwaltete Person ohne jede Event-Historie kann wieder gelöscht
  werden.

## 3. Nicht-Ziel

- Keine geteilte Verwaltung nach der Umwandlung — sobald eine verwaltete
  Person einen eigenen Account hat, ist die Bindung zum Haupt-Account
  vollständig aufgelöst.
- Keine eigene Gruppen-/Berechtigungs-Differenzierung dafür, wer verwaltete
  Personen anlegen darf — jeder nicht-Gast-Account darf das (siehe
  Diskussion zu `requireMenu`/`canEditCharacters`: bewusst nicht
  wiederverwendet, da dieses Feature unabhängig von Charakter-Rechten ist).
- Keine Mehrfach-Verwaltung derselben Person durch mehrere Haupt-Accounts.
- Kein Soft-Delete/Deaktivieren verwalteter Personen — nur Hard-Delete,
  blockiert sobald Event-Historie existiert (siehe 5.1).

## 4. Datenmodell

### Migration 058

```sql
ALTER TABLE users ADD COLUMN managed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX users_managed_by_user_id_idx ON users (managed_by_user_id) WHERE managed_by_user_id IS NOT NULL;
```

`managed_by_user_id` unterscheidet eine vom Haupt-Account verwaltete
Person (gesetzt) von einem anonymen Ticket-Widget-Gast (`NULL`, wie
heute). `ON DELETE SET NULL`: wird der Haupt-Account gelöscht, bleibt die
verwaltete Person als gewöhnlicher, nicht mehr zugeordneter Gast-Account
bestehen (ihre Event-Historie geht nicht verloren) — ein Admin kann sie
weiterhin über `admin/members.html` sehen und manuell konvertieren/löschen.

## 5. Backend

### 5.1 Neues Modul `backend/managedPersons/`

`repository.js`:
- `createManagedPerson(ownerId, { email, firstName, lastName, nickname, ...otFields })`
  — lädt `ownerId`s `group_id`, legt eine `users`-Zeile mit
  `is_guest=true`, `managed_by_user_id=ownerId`, derselben Gruppe an.
  Verschlüsselte OT-Felder genau wie `createInvitation`
  (`backend/invitations/repository.js:37`): Schema laden, nur bekannte
  Keys in den `account_data_enc`-Blob übernehmen.
- `listManagedPersons(ownerId)` — `SELECT ... WHERE managed_by_user_id = $1`,
  gleiche Spalten/Decrypt wie `getAccount` (`backend/accounts/repository.js`),
  zusätzlich pro Zeile `canDelete: NOT EXISTS (SELECT 1 FROM registrations
  WHERE registrations.user_id = users.id)` (Korrelated Subquery in der
  SELECT-Liste) — das Frontend zeigt den Löschen-Button entsprechend
  aktiv/inaktiv, ohne selbst nachzufragen.
- `getManagedPerson(id, ownerId)` — wie oben, `WHERE id = $1 AND managed_by_user_id = $2`;
  `null` wenn nicht gefunden oder nicht eigene → einheitlich 404 statt 403
  (verrät nicht, ob die ID überhaupt existiert).
- `updateManagedPerson(id, ownerId, fields)` — wie `updateAccount`, zusätzlich
  mit `AND managed_by_user_id = $ownerId` in der `UPDATE`-Query.
- `deleteManagedPerson(id, ownerId)` — prüft zuerst
  `SELECT 1 FROM registrations WHERE user_id = $1`; falls vorhanden, Fehler
  `HAS_REGISTRATIONS`. Sonst `DELETE FROM users WHERE id = $1 AND managed_by_user_id = $2 RETURNING id`.

`routes.js` (alle `requireAuth`, Ownership über `getManagedPerson`/die
`AND managed_by_user_id = user.id`-Klauseln oben, kein `is_guest`-Account
darf selbst verwaltete Personen anlegen — Prüfung `if (user.isGuest) return 403`):
- `POST /managed-persons`
- `GET /managed-persons`
- `GET /managed-persons/:id`
- `PATCH /managed-persons/:id`
- `DELETE /managed-persons/:id`
- `POST /managed-persons/:id/characters`, `GET /managed-persons/:id/characters`
  — laden die verwaltete Person per `getManagedPerson(params.id, user.id)`,
  dann identischer Body/Response wie `POST`/`GET /characters`
  (`backend/characters/routes.js:11`/`:33`), nur mit `createCharacter`/
  `listCharactersForUser` auf die verwaltete Person statt `user.id`.
- `POST /managed-persons/:id/events/:eventId/register`,
  `DELETE /managed-persons/:id/events/:eventId/register`,
  `GET /managed-persons/:id/registrations`
  — identisch zu `backend/registrations/routes.js:37/63/74`, rufen
  `registerForEvent`/`unregisterFromEvent`/`listRegistrationsForUser` mit
  der verwalteten Person als `userId` auf. `requestingUser` für
  `registerForEvent` wird aus der verwalteten Person selbst gebaut
  (`{ id, group }`, analog zum bestehenden Gast-Flow in
  `backend/guestRegistrations/routes.js:84`) — Berechtigungen wie
  Charakter-Zugriff richten sich nach der Gruppe der verwalteten Person,
  nicht der des Haupt-Accounts.
- `POST /managed-persons/:id/convert` — lädt die verwaltete Person,
  erzeugt eine Invitation wie `generate-conversion-link`
  (`backend/members/routes.js:214`, `createInvitation({ userId: ... })`),
  aber `invitedBy: user.id` statt des Admin-Accounts. Verschickt
  automatisch per Mail (`sendInvitationEmail`, wie `/members/invite`),
  wenn die verwaltete Person eine E-Mail hat; sonst 400
  `"E-Mail-Adresse erforderlich, um einen Account zu erstellen"` (muss
  vorher per `PATCH /managed-persons/:id` ergänzt werden).

### 5.1.1 Vollständige Trennung bei Umwandlung

`backend/auth/invite.js`'s Guest-Conversion-Zweig (Zeile 40-44, `UPDATE
users SET password_hash = ..., is_guest = false, ...`) setzt heute
`managed_by_user_id` NICHT zurück. Da jeder erweiterte Ownership-Check in
5.2 ausschließlich über `managed_by_user_id` geht (keine separate
Berechtigung), muss diese `UPDATE`-Query um `managed_by_user_id = NULL`
ergänzt werden — sonst behielte der Haupt-Account nach der Umwandlung
weiterhin Zugriff auf Charaktere/Anmeldungen, was Abschnitt 2
("verliert der Haupt-Account jeden Zugriff") widerspricht. Gilt nur für
diesen Zweig; der Neuanlage-Zweig (kein `invitation.userId`) ist nicht
betroffen.

### 5.2 Erweiterte Ownership-Checks

- `backend/characters/routes.js` (`GET`/`PUT`/`DELETE /characters/:id`)
  und `backend/characterFiles/routes.js`: `isOwner`-Berechnung wird um
  "oder `character.user_id` ist eine vom aktuellen User verwaltete Person"
  erweitert — eine Hilfsfunktion `isOwnerOrManagedBy(targetUserId, user)`
  (neu in `backend/managedPersons/repository.js`, `SELECT 1 FROM users
  WHERE id = $1 AND managed_by_user_id = $2`), an jeder der ~5 Stellen
  statt der reinen `character.user_id === user.id`/`params.userId ===
  user.id`-Prüfung.
- `backend/payments/routes.js:43` (`POST
  /events/:eventId/registrations/:userId/checkout-session`): gleiche
  Erweiterung — `params.userId !== user.id` UND nicht
  `isOwnerOrManagedBy(params.userId, user)` → 403.

### 5.3 Feld-Berechtigung bei Anlage/Bearbeitung

`createManagedPerson`/`updateManagedPerson` filtern OT-Felder über
dieselbe Logik wie `filterToAllowedFields` in
`backend/members/routes.js:15` (dort lokal, wird exportiert und hier
mitgenutzt) — der Haupt-Account darf einer verwalteten Person nur Felder
setzen, die er laut `user.group.accountFields` auch auf seinem eigenen
Account setzen dürfte. `group` ist kein erlaubtes Feld (wird serverseitig
immer vom Haupt-Account übernommen, siehe 2.).

## 6. Frontend

### 6.1 `frontend/account.html`

- Neuer Abschnitt "Verwaltete Personen" (ausgeblendet für `is_guest`-
  Accounts, die selbst keine verwalteten Personen haben können):
  - Liste bestehender verwalteter Personen (Name, Status: "nur Platzhalter"
    / "Umwandlung ausstehend" / E-Mail falls vorhanden).
  - "Person hinzufügen"-Formular: Vorname/Nachname/Nickname + dieselben
    OT-Feld-Inputs wie das bestehende Account-Formular, über
    `formFields.js`'s bestehendes Rendering (kein neuer Feldtyp).
  - Pro Person: "Bearbeiten" (öffnet dasselbe Formular befüllt, `PATCH`),
    "Löschen" (Button, nur aktiv wenn keine Registrierungen — Server
    liefert den Zustand bereits über eine fehlende Lösch-Berechtigung im
    Response der Liste, z.B. `canDelete: boolean`), "In Account umwandeln"
    (nur sichtbar mit hinterlegter E-Mail → `POST .../convert`, danach
    Erfolgsmeldung "Einladung verschickt").
  - Pro Person ein Link "Charaktere & Anmeldung verwalten" →
    `characters.html?managedPersonId=<id>`.

### 6.2 `frontend/characters.html`

- Liest optional `?managedPersonId=` aus der URL. Wenn gesetzt: lädt die
  verwaltete Person (`GET /managed-persons/:id`) für Namen/Header-Anzeige
  ("Charaktere von Lena verwalten") und richtet alle Fetches auf die
  `/managed-persons/:id/...`-Varianten statt `/characters`/
  `/events/:id/register` — gleiche Formulare, gleiche Validierung, nur
  andere Basis-URL (eine kleine `apiBase()`-Hilfsfunktion am Seitenanfang
  statt jedes Fetch-Calls einzeln anzupassen).
- Zahlungs-Button (falls Betrag fällig) ruft
  `/events/:eventId/registrations/:managedPersonId/checkout-session` auf
  (bereits in 5.2 auf Ownership erweitert) statt der eigenen ID.

## 7. Fehlerbehandlung

- Jede `/managed-persons/:id...`-Route: verwaltete Person nicht gefunden
  oder nicht eigene → 404 (nie 403, siehe 5.1).
- `is_guest`-Account versucht `POST /managed-persons` → 403
  `"Gast-Accounts können keine Personen verwalten"`.
- `DELETE /managed-persons/:id` mit bestehender Registrierung → 409
  `"Diese Person hat bereits Event-Anmeldungen und kann nicht gelöscht werden."`
- `POST /managed-persons/:id/convert` ohne hinterlegte E-Mail → 400.
- `POST /managed-persons/:id/convert`, wenn bereits eine offene,
  nicht abgelaufene Invitation für diese Person existiert: erzeugt heute
  bewusst einfach eine zweite, unabhängige Invitation (gleiches Verhalten
  wie der bestehende admin-seitige `generate-conversion-link`-Endpunkt,
  der denselben Fall ebenfalls nicht abfängt — `createInvitation` hat
  keinen Uniqueness-Guard, `invitations_email_idx` ist nur ein
  Lookup-Index, keine Unique-Constraint). Kein neues Guard für dieses
  Feature; beide Links bleiben bis zum Ablauf gültig, der zuerst
  eingelöste gewinnt (`markRedeemed`s Race-Guard).
- Alle Charakter-/Registrierungs-Fehlercodes (`EVENT_NOT_ACTIVE`,
  `ALREADY_REGISTERED`, `INVALID_CON_ROLE`, ...) werden 1:1 wie bei den
  bestehenden Self-Service-Routen gemappt.

## 8. Tests

- Neues `tests/integration/managedPersons.test.js`:
  - Anlegen, Liste, Einzelabruf, Bearbeiten (inkl. Feld-Berechtigungs-
    Filter), Löschen (erlaubt ohne Historie, blockiert mit Registrierung).
  - Fremdzugriff: Account B kann Account A's verwaltete Person nicht lesen/
    bearbeiten/löschen (404, nicht 403).
  - Gast-Account kann keine verwalteten Personen anlegen (403).
  - Charakter anlegen/auflisten für eine verwaltete Person; Zugriff über
    `GET/PUT/DELETE /characters/:id` als Haupt-Account funktioniert, als
    fremder Account nicht.
  - Event-Anmeldung/-Abmeldung für eine verwaltete Person, inklusive
    Checkout-Session-Aufruf als Haupt-Account (Stripe-Client gemockt, wie
    in den bestehenden Payment-Tests).
  - Umwandlung: Invitation wird mit korrektem `userId`/`invitedBy`
    erzeugt, E-Mail wird verschickt (Mailer-Mock, wie bei
    `members.test.js`), danach regulärer Redeem-Flow
    (`backend/auth/invite.js`) macht aus der verwalteten Person einen
    vollwertigen Account mit eigenem Passwort — bestehende Charaktere/
    Registrierungen bleiben erhalten, `managed_by_user_id` wird auf `NULL`
    zurückgesetzt (siehe 5.1.1), und der ehemalige Haupt-Account hat
    danach nachweislich keinen Zugriff mehr (`GET/PUT /characters/:id`
    als Haupt-Account → 403/404).
- Migration-Test: `managed_by_user_id` Spalte + Index vorhanden, FK-
  Verhalten `ON DELETE SET NULL` (Haupt-Account löschen → verwaltete
  Person bleibt, Feld wird `NULL`).
- Letzter Schritt des letzten Tasks: vollständiger `npm test`-Lauf
  (Projekt-Konvention).

## 9. Migrationsreihenfolge / Risiko

Migration 058 ist additiv (neue nullable Spalte + Index), kein Daten-
verlustrisiko, kann unabhängig vom restlichen Code zuerst laufen. Das
größte Restrisiko liegt in den ~6 Stellen mit erweitertem Ownership-Check
(5.2) — jede einzeln gegen den bestehenden Self-Service-Fall UND den
neuen verwalteten-Personen-Fall testen, nicht nur den neuen Pfad (Lehre
aus früheren Plänen dieses Projekts: Berechtigungs-Erweiterungen an
mehreren Stellen sind die häufigste Quelle für von Einzel-Reviews
übersehene, erst im Gesamt-Review auffallende Lücken).
