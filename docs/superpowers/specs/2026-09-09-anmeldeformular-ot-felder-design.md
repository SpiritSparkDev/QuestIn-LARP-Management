# Anmeldeformular: Con-Tage/Unterbringung/Handwerk/Anreise/Opt-Outs — Design Spec

**Vorgänger-Spec:** `docs/superpowers/specs/2026-09-08-charakter-con-anmeldung-entkoppeln-design.md` (Teil 2)

Dritter von fünf Teilen des User-Testing-Feedback-Pakets. Verschiebt die 6
Felder `conTage`, `accommodation`, `craftOffer`, `travelMethod`,
`dataSharingOptOut`, `photoOptOut` vom Konto (account-weit, eine Antwort für
alle Events) in die Con-Anmeldung (pro Event eine eigene Antwort).

## 1. Problem

Diese 6 Felder leben heute (Migration 024) als verschlüsselte Spalten auf
`users`/`invitations` und werden auf `account.html` einmalig pro Konto
gepflegt. Das passt nicht zur Realität: Con-Tage, Unterbringungswunsch,
Handwerksangebot, Anreiseart und die beiden Opt-Outs können sich von Event zu
Event unterscheiden. Ein Nutzer, der für zwei Cons angemeldet ist, kann heute
nur EINE Antwort je Feld hinterlegen, die für beide Anmeldungen gilt.

## 2. Ziel

- Die 6 Felder werden Teil der Con-Anmeldung (`con-anmeldungen.html`) statt
  des Kontos — jede Registrierung trägt ihre eigenen Werte.
- Optional wie bisher, keine neuen Pflichtfelder.
- Nachträgliches Ändern einer bereits eingereichten Anmeldung ist möglich,
  löst aber eine Benachrichtigung an Event-Orga/-Hilfs-Orga und
  System-Admin/-Moderator aus (Erst-Einreichung nicht).

## 3. Nicht-Ziel

- Bestandsdaten-Migration der bisherigen Account-Werte — werden verworfen,
  alle Registrierungen starten mit leeren Werten für diese 6 Felder.
- In-App-Benachrichtigungssystem — nur E-Mail über die bestehende
  SMTP-Infrastruktur (`backend/auth/mailer.js`).
- Editieren von Event/Rolle/Charakter einer bestehenden Anmeldung — bleibt
  wie in Teil 2 festgelegt außerhalb des Plans (abmelden + neu anmelden).
- UI-Text-/Typo-Politur (Teil 4) und Regelwerk-Ergänzungen (Teil 5).

## 4. Datenmodell

### 4.1 Migration `030_anmeldung_ot_felder.sql`

```sql
-- 1. Neue verschlüsselte Spalten auf registrations (nullable, optional).
ALTER TABLE registrations ADD COLUMN con_tage_enc bytea;
ALTER TABLE registrations ADD COLUMN accommodation_enc bytea;
ALTER TABLE registrations ADD COLUMN craft_offer_enc bytea;
ALTER TABLE registrations ADD COLUMN travel_method_enc bytea;
ALTER TABLE registrations ADD COLUMN data_sharing_opt_out_enc bytea;
ALTER TABLE registrations ADD COLUMN photo_opt_out_enc bytea;

-- 2. Bestandsdaten verwerfen (kein Backfill) -- die 6 Felder verschwinden
--    komplett von users/invitations, beide Spaltensätze fallen weg.
ALTER TABLE users
  DROP COLUMN con_tage_enc,
  DROP COLUMN accommodation_enc,
  DROP COLUMN craft_offer_enc,
  DROP COLUMN travel_method_enc,
  DROP COLUMN data_sharing_opt_out_enc,
  DROP COLUMN photo_opt_out_enc;

ALTER TABLE invitations
  DROP COLUMN con_tage_enc,
  DROP COLUMN accommodation_enc,
  DROP COLUMN craft_offer_enc,
  DROP COLUMN travel_method_enc,
  DROP COLUMN data_sharing_opt_out_enc,
  DROP COLUMN photo_opt_out_enc;
```

### 4.2 `backend/accountFields.js` schrumpft

`ACCOUNT_FIELD_KEYS`/`ENCRYPTED_ACCOUNT_FIELD_COLUMNS` verlieren die 6 Keys,
verbleiben 8 echte Kontofelder (address, birthdate, phone,
emergencyContactLastName/FirstName/Phone, medicalNotes, group).

### 4.3 Neue Datei `backend/registrationFields.js`

Gleiches Muster wie `accountFields.js`, eigene Spalten-Map:

```javascript
export const REGISTRATION_FIELD_KEYS = [
  'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut',
];

export const ENCRYPTED_REGISTRATION_FIELD_COLUMNS = {
  conTage: 'con_tage_enc',
  accommodation: 'accommodation_enc',
  craftOffer: 'craft_offer_enc',
  travelMethod: 'travel_method_enc',
  dataSharingOptOut: 'data_sharing_opt_out_enc',
  photoOptOut: 'photo_opt_out_enc',
};

// decryptEncryptedRegistrationFields(row) / encryptRegistrationFieldValues(fields)
// -- identische Form wie die accountFields-Pendants, importieren dieselben
// encryptField/decryptField-Helfer aus crypto/fieldCrypto.js.
```

## 5. Backend

### 5.1 `registerForEvent` (Ersteinreichung)

`backend/registrations/repository.js`s `registerForEvent(userId, eventId,
conRole, characterId, otFields, requestingUser)` bekommt einen neuen,
optionalen `otFields`-Parameter (die 6 Keys, jeder für sich optional). Die
Werte werden verschlüsselt ins selbe INSERT wie `character_id` geschrieben.
Kein E-Mail-Versand hier — das ist die Ersteinreichung, keine Änderung.

`listRegistrationsForUser(userId)` liefert die 6 entschlüsselten Felder pro
Zeile mit aus (analog `conRole`/`characterId` aus Teil 2) — die
"Bearbeiten"-Ansicht auf `con-anmeldungen.html` (6.1) braucht sie zum
Vorausfüllen, ohne einen zweiten Roundtrip pro Registrierung.

### 5.2 Neue Route: Anmeldung nachträglich bearbeiten

`PUT /events/:id/registrations/:userId/ot-fields`, `requireAuth`, nur wenn
`userId === requestingUser.id` (kein Fremdzugriff, anders als die
con-role-Promotion-Route — hier gibt es keine Orga-Override-Berechtigung).

```javascript
router.put('/events/:id/registrations/:userId/ot-fields', requireAuth(async ({ req, params, user }) => {
  if (params.userId !== user.id) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    const registration = await updateRegistrationOtFields(params.id, user.id, body);
    await notifyRegistrationOtFieldsChanged(params.id, user.id); // fire-and-forget, try/catch innen
    return { status: 200, body: registration };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    throw err;
  }
}));
```

`updateRegistrationOtFields(eventId, userId, otFields)` im Repository:
UPDATE der 6 verschlüsselten Spalten (COALESCE-Muster wie
`updateCharacter`), wirft `REGISTRATION_NOT_FOUND` wenn keine Zeile trifft.

### 5.3 Benachrichtigung bei Änderung

Neue Funktion `sendRegistrationOtFieldsChangedEmail(to, { userName,
eventName })` in `backend/auth/mailer.js`, gleiches Muster wie
`sendInvitationEmail`.

Empfänger-Auflösung (neue Funktion, z. B. in
`backend/registrations/repository.js`): alle User mit
`con_role IN ('orga', 'hilfs_orga')` für dieses Event UND alle User deren
`group.key IN ('admin', 'moderator')` (systemweit) — Vereinigungsmenge,
jede E-Mail einzeln verschickt, jede in eigenem try/catch (ein
Zustellungsfehler blockiert weder die Speicherung noch die übrigen Mails).

### 5.4 Sichtbarkeit in Check-In/Teilnehmerliste

`listParticipantsForEvent`/`getScanLookup`: die 6 Felder werden wie die
bisherigen `otFields` behandelt, aber aus `registrations` statt `users`
gelesen, weiterhin gefiltert über `viewer.group.accountFields` — die
Feld-Keys (`conTage` etc.) bleiben identisch, nur `ENCRYPTED_ACCOUNT_FIELD_COLUMNS`
wird für diesen Zweck durch `ENCRYPTED_REGISTRATION_FIELD_COLUMNS` ersetzt
(zwei Spaltenquellen, eine gemeinsame Berechtigungsliste
`group.accountFields`, kein neues Berechtigungs-Konzept).

## 6. Frontend

### 6.1 `frontend/con-anmeldungen.html`

- "Neu anmelden"-Formular bekommt die 6 Felder zusätzlich zu
  Event/Rolle/Charakter/Schema-Feldern. Absenden ruft `registerForEvent`
  mit `otFields` mit — keine Mail.
- "Meine Anmeldungen"-Tabelle bekommt eine neue Spalte/Button "Bearbeiten"
  pro Zeile (unabhängig vom Status, wie besprochen — nicht nur `pending`).
  Klick öffnet ein Formular mit denselben 6 Feldern, vorausgefüllt mit den
  aktuellen Werten (aus `GET /registrations`, das die 6 Felder mit
  ausliefert), plus Warnhinweis ("Diese Änderung benachrichtigt Orga und
  Admin per E-Mail."). Speichern ruft `PUT
  /events/:id/registrations/:userId/ot-fields`.
- Event/Rolle/Charakter bleiben in diesem Bearbeiten-Formular nicht
  editierbar (das ist weiterhin nur über Abmelden+Neuanmelden möglich).

### 6.2 `frontend/account.html`

Die 6 Felder (Zeilen `conTage`…`photoOptOut`) inklusive Labels komplett
entfernt, `data.dataSharingOptOut`/`photoOptOut`-Zeilen aus dem
Submit-Handler entfernt.

### 6.3 `frontend/admin/members.html`

Vorbefüllungsfelder für die 6 Keys im Invite-Dialog entfernt (kein
Account-Ziel mehr, ergeben keinen Sinn).

### 6.4 `frontend/admin/checkin.html`

Keine strukturelle Änderung nötig — die Teilnehmerliste zeigt weiterhin ein
`otFields`-Objekt mit denselben 6 Keys, jetzt aus `registrations` befüllt.

## 7. Fehlerbehandlung

- Bearbeiten einer fremden Registrierung → 403.
- Bearbeiten einer nicht existierenden Registrierung → 404
  `REGISTRATION_NOT_FOUND`.
- E-Mail-Versand-Fehler beim Notify → geloggt, blockiert weder Speicherung
  noch Response.
- Keine serverseitige Validierung auf den 6 Feldern (Freitext/Checkbox,
  optional — wie bisher).

## 8. Tests

- Migration + jeder Backend-Konsument (`registerForEvent`,
  `updateRegistrationOtFields`, `listParticipantsForEvent`,
  `getScanLookup`) — analog Teil 1/Teil 2.
- Neue Route: Owner darf bearbeiten, Fremder bekommt 403, unbekannte
  Registrierung 404.
- Ersteinreichung (`POST /events/:id/register` mit `otFields`) löst keinen
  Mailer-Aufruf aus; `PUT .../ot-fields` löst genau einen Aufruf pro
  aufgelöstem Empfänger aus (Empfänger-Auflösungsfunktion ist pur genug für
  einen eigenen Unit-Test ohne echten SMTP-Versand — Tests laufen ohnehin
  mit `SMTP_HOST` gelöscht, also `jsonTransport`-Fallback, kein Zustellungs-
  Assert nötig).
- `account.html`/Invite-Dialog: keine dedizierten neuen Tests nötig, aber
  bestehende `account.test.js`/`members.test.js`-Fälle, die diese 6 Felder
  noch anfassen, müssen angepasst werden (Felder existieren dort nicht
  mehr).

## 9. Sicherheitshinweis für den Rollout

Wie in Teil 1/Teil 2: Migration + Backend-Änderungen laufen zuerst gegen
die aktuelle Dev-Datenbank getestet werden, bevor auf Produktion
ausgerollt wird — Spaltendrop auf `users`/`invitations` ist nicht
rückgängig zu machen ohne Backup.
