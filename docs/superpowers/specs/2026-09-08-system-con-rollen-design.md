# System- vs. Con-Rollen — Design Spec

**Vorgänger-Specs:** `docs/superpowers/specs/2026-08-26-gruppen-berechtigungen-design.md`,
`docs/superpowers/specs/2026-08-28-charakterklassen-und-hardening-design.md`

Erster von fünf Teilen eines größeren User-Testing-Feedback-Pakets (Rollen-Trennung,
Onboarding-Pipeline, Stammdaten-vs.-Anmeldung, UI-Politur, Regelwerk-Ergänzungen).
Dieser Spec deckt ausschließlich Teil 1 ab — die Trennung von System-Rechten und
Con-spezifischen Rollen. Teile 2–5 werden als eigene, spätere Specs/Pläne behandelt.

## 1. Problem

Das heutige `groups`-System (`db/groupDefaults.js`, `backend/groups/`) fusioniert
zwei eigentlich unabhängige Dinge in einer einzigen Zuweisung pro Nutzer:

- **System-Rechte**: welche Admin-Menüs sichtbar sind (`visible_menus`), ob man
  fremde Charaktere bearbeiten (`can_edit_characters`) oder Check-In-Status
  überschreiben darf (`can_override_checkin_status`), welche Kontofelder man bei
  Mitgliedern sehen/editieren darf (`account_fields`).
- **Con-spezifische Rolle**: welche Charakterklasse (`sc`/`nsc`) man anlegen darf
  (`character_classes`).

Das führt dazu, dass die Con-Rolle eines Nutzers bei der Registrierung faktisch
für immer festgelegt wird (welcher Gruppe man zugewiesen ist entscheidet, ob man
SC- oder NSC-Charaktere anlegen kann) — es gibt keinen Weg, sich als Basis-Mitglied
zu registrieren und die Rolle erst pro Event zu wählen.

## 2. Ziel

- Ein neuer Nutzer registriert sich mit Basis-Rechten ("Mitglied") ohne
  Festlegung auf SC/NSC.
- Die Con-Rolle (SC/NSC/GSC/Helfer/Orga/Hilfs-Orga) wird **pro Event-Anmeldung**
  gewählt, nicht am Konto.
- System-Rechte werden auf genau drei Stufen reduziert: `admin`, `moderator`,
  `mitglied`.

## 3. Nicht-Ziel (explizit außerhalb dieses Plans)

- Wie Charaktere künftig mit einer Anmeldung verknüpft werden (Auswahl eines
  bestehenden Charakters statt Charakter-Erstellung == Anmeldung), der eigene
  "Con-Anmeldungen"-Reiter, die Entkopplung von Charaktererstellung und Event —
  das ist Teil 2.
- Verschieben von `conTage`/`accommodation`/`craftOffer`/`travelMethod` aus den
  Kontoeinstellungen in das Anmeldeformular — das ist Teil 3. Diese Felder
  bleiben in diesem Plan unverändert auf `users`/`invitations`.
- UI-Text-/Typo-Politur (Teil 4) und Regelwerk-Ergänzungen wie Magiearten,
  Regelsystem-Feld, PDF-Upload (Teil 5) — eigene, spätere Pläne.
- `characters.event_id`-Bindung von SC-Charakteren bei der Erstellung bleibt
  unverändert (weiterhin `NOT NULL` für `class = 'sc'`).

## 4. Datenmodell

### 4.1 `groups` auf drei System-Rollen reduzieren

Die Spalte `character_classes` entfällt (ersetzt durch `registrations.con_role`,
siehe 4.2). Die Tabelle wird auf drei Zeilen reduziert:

| key | Menüs | can_edit_characters | can_override_checkin_status | account_fields | is_protected |
|---|---|---|---|---|---|
| `admin` | konto, charaktere, mitglieder, events, checkin | true | true | (wie heute admin, inkl. `group`) | true |
| `moderator` | konto, charaktere, mitglieder, events, checkin | true | true | (wie heute `orga`, ohne `group`) | false |
| `mitglied` | konto, charaktere | false | false | `[]` | false |

`moderator` übernimmt das heutige `orga`-Rechtebündel 1:1 (der vollständigste
Nicht-Admin-Tier) — `plot_orga`/`sl`/`hilfs_sl` brauchen weiterhin
Check-In-Zugriff für den Con-Betrieb, eine Abstufung würde bestehende
Arbeitsabläufe brechen.

**Migration (neue Datei `db/migrations/027_system_con_rollen.sql`)**, analog zum
Muster aus Migration 014 (`finalize_group_id`) — transaktionsgeschützt, selbst-
befüllend:

```sql
-- Neue Zielgruppen anlegen (idempotent)
INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status, is_protected)
VALUES
  ('moderator', 'Moderator', '["konto","charaktere","mitglieder","events","checkin"]'::jsonb,
   '["address","birthdate","phone","emergencyContactLastName","emergencyContactFirstName","emergencyContactPhone","medicalNotes","conTage","accommodation","craftOffer","travelMethod","dataSharingOptOut","photoOptOut"]'::jsonb,
   true, true, false),
  ('mitglied', 'Mitglied', '["konto","charaktere"]'::jsonb, '[]'::jsonb, false, false, false)
ON CONFLICT (key) DO NOTHING;

-- Bestehende User auf die 3 neuen Gruppen ummappen
UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'moderator')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl'));

UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'mitglied')
WHERE group_id IN (SELECT id FROM groups WHERE key IN ('sc', 'gsc', 'nsc'));

-- (admin bleibt unverändert)

-- Alte, jetzt verwaiste Gruppen löschen
DELETE FROM groups WHERE key IN ('orga', 'plot_orga', 'sl', 'hilfs_sl', 'sc', 'gsc', 'nsc');

ALTER TABLE groups DROP COLUMN character_classes;
```

`db/groupDefaults.js` und `db/seedGroups.js` werden auf die 3 neuen Zeilen
reduziert (kein `characterClasses`-Feld mehr) — Lehre aus Migration 014/Plan 1
der Gruppen-Initiative: Migration, `groupDefaults.js` und `seedGroups.js` müssen
für ALLE Zeilen übereinstimmen, sonst driften Fresh-Install-Seeds und bestehende
DBs auseinander.

### 4.2 Con-Rolle auf `registrations`

Neue Spalte, Teil derselben Migration:

```sql
ALTER TABLE registrations ADD COLUMN con_role text
  CHECK (con_role IN ('sc', 'nsc', 'gsc', 'helfer', 'orga', 'hilfs_orga'));

-- Bestehende Zeilen aus der bisherigen Gruppe des Users befüllen
UPDATE registrations r SET con_role = sub.mapped
FROM (
  SELECT u.id AS user_id, CASE g.key
    WHEN 'sc' THEN 'sc' WHEN 'gsc' THEN 'gsc' WHEN 'nsc' THEN 'nsc'
    WHEN 'orga' THEN 'orga' WHEN 'plot_orga' THEN 'orga' WHEN 'sl' THEN 'orga'
    WHEN 'hilfs_sl' THEN 'hilfs_orga' WHEN 'admin' THEN 'orga'
  END AS mapped
  FROM users u JOIN groups g ON g.id = u.group_id
) sub
WHERE r.user_id = sub.user_id AND r.con_role IS NULL;
-- Hinweis: das Backfill muss VOR dem Ummappen der Gruppen (4.1) laufen, siehe
-- Reihenfolge unten in "Migrations-Reihenfolge".

ALTER TABLE registrations ALTER COLUMN con_role SET NOT NULL;
```

**Wer darf `con_role` auf `orga`/`hilfs_orga` setzen** (bei Erst-Anmeldung oder
nachträglicher Änderung): der Aufrufer selbst hat `con_role IN ('orga','hilfs_orga')`
für **dasselbe Event**, oder System-Rolle `moderator`/`admin`. Alle anderen Werte
(`sc`/`nsc`/`gsc`/`helfer`) sind für jeden angemeldeten Nutzer frei wählbar.

### 4.3 Migrations-Reihenfolge innerhalb 027

1. `con_role`-Spalte anlegen (nullable)
2. Backfill über die **noch alten** Gruppen (Abschnitt 4.2)
3. `con_role` NOT NULL setzen
4. Neue Gruppen `moderator`/`mitglied` anlegen, User ummappen, alte Gruppen löschen
   (Abschnitt 4.1)
5. `character_classes`-Spalte droppen

(Backfill muss vor dem Gruppen-Umbau laufen, weil er die alten Gruppenschlüssel
braucht, die danach gelöscht werden.)

## 5. Backend-Änderungen

### 5.1 `backend/characters/routes.js`

`POST /characters` verliert die Prüfung
`if (!user.group.characterClasses.includes(characterClass))` ersatzlos — jede
angemeldete Person darf sowohl SC- als auch NSC-Charaktere anlegen. Die
bestehende `canEditCharacters`/`event.is_active`-Prüfung für SC-Charaktere
bleibt unverändert.

### 5.2 `backend/groups/` (repository.js, routes.js)

`characterClasses` komplett aus `createGroup`/`updateGroup`, den Routen-Handlern,
`CHARACTER_CLASS_KEYS`/`isValidCharacterClassList` entfernen. `SELECT_COLUMNS`
verliert `character_classes`.

### 5.3 `backend/middleware/authenticate.js` und `backend/accounts/repository.js`

`characterClasses` aus dem `user.group`-Objekt und aus `GET /account` entfernen.

### 5.4 `backend/registrations/`

- `registerForEvent(userId, eventId, conRole)`: `conRole` aus dem Request-Body,
  validiert gegen die erlaubten Werte; bei `orga`/`hilfs_orga` zusätzlich die in
  4.2 beschriebene Berechtigungsprüfung (eigene `con_role` für **dieses** Event
  oder System-Rolle `moderator`/`admin`), sonst `403`.
- Neuer Endpunkt `PUT /events/:id/registrations/:userId/con-role` zum
  nachträglichen Ändern (Beförderung zu Orga/Hilfs-Orga), gleiche
  Berechtigungsprüfung, gated auf `requireMenu('checkin')` wie die bestehenden
  Check-In-Endpunkte.
- **Bugfix**: `approveRegistration` verlangt aktuell zwingend einen Charakter
  (`NO_CHARACTER`-Fehler sonst). Diese Prüfung muss übersprungen werden, wenn
  `con_role IN ('helfer', 'orga', 'hilfs_orga')` — diese Rollen haben kein
  Charakterblatt. Ohne diese Anpassung könnten Helfer/Orga nie freigegeben
  werden.
- `listParticipantsForEvent`/`getScanLookup`: beide liefern aktuell `group`/
  `group_key` als Rolleninfo aus (bei `getScanLookup` bisher aussagekräftig,
  z.B. `sl`/`gsc` — nach dem Umbau wäre das für fast alle nur noch `mitglied`).
  Beide Funktionen liefern stattdessen zusätzlich `con_role` für das jeweilige
  Event aus; `group`/`group_key` bleiben als Feld erhalten (jetzt mit einem der
  3 System-Rollen-Werte), damit bestehende Konsumenten nicht brechen.

### 5.5 `backend/nscSchema/routes.js`

`GET /nsc-schema` prüft aktuell `user.group.key !== 'admin' && !user.group.characterClasses.includes('nsc')`.
Da `characterClasses` entfällt und jeder NSC-Charaktere anlegen darf, wird die
Prüfung auf reine Authentifizierung reduziert (jeder angemeldete Nutzer darf das
Schema lesen — es ist ohnehin nur die Formularstruktur, keine personenbezogenen
Daten).

## 6. Frontend-Änderungen

- **`frontend/admin/groups.html`**: Charakterklassen-Checkboxen entfernen. Liste
  zeigt nur noch `admin`/`moderator`/`mitglied` (admin-Zeile weiterhin
  schreibgeschützt).
- **`frontend/characters.html`**:
  - Beide "Neuen Charakter erstellen"-Buttons (SC/NSC) sind ab jetzt für alle
    sichtbar, keine `group.characterClasses`-Prüfung mehr im Frontend.
  - Registrierungsformular (`#register-button`-Bereich) bekommt eine
    Rollen-Auswahl (`sc`/`nsc`/`gsc`/`helfer` immer; `orga`/`hilfs_orga` nur
    wenn der Nutzer für dieses Event bereits `orga`/`hilfs_orga` ist oder
    System-Rolle `moderator`/`admin` hat — Sichtbarkeit clientseitig, echte
    Durchsetzung serverseitig wie in 5.4 beschrieben). `POST /events/:id/register`
    sendet `{ conRole }` mit.
- **`frontend/admin/members.html`**: Gruppen-Dropdown zeigt die 3 neuen Werte
  statt der bisherigen 8.
- **`frontend/admin/checkin.html`**: überall wo bisher die Gruppe als Rolleninfo
  pro Teilnehmer angezeigt wurde (Teilnehmerliste, QR-Scan-Ergebnis), wird das
  auf `con_role` umgestellt — die Gruppe allein ist nach dem Umbau nicht mehr
  aussagekräftig (fast alle sind `mitglied`).

## 7. Betroffene Tests

Alle Tests, die `characterClasses`/`character_classes` referenzieren, müssen
angepasst oder entfernt werden — mindestens:
`tests/integration/accounts.test.js` (characterClasses-Assertion),
`tests/integration/groups.test.js` (characterClasses-Tests),
`tests/integration/seedGroups.test.js`, `tests/integration/schema-users.test.js`
(character_classes-Assertion). Neue Tests für: Backfill-Migration (8→3 Gruppen,
`con_role` korrekt befüllt), `con_role`-Validierung bei `POST /events/:id/register`
(inkl. 403 für unberechtigte orga/hilfs_orga-Wahl), den neuen
Beförderungs-Endpunkt, und den `approveRegistration`-Bugfix für
helfer/orga/hilfs_orga ohne Charakter.

## 8. Rollout-Risiko

Die Migration löscht 5 Gruppen und mappt bestehende User/Registrations um — echte
Datenmigration, kein rein additiver Schritt. Wie bei Migration 016
(emergency-contact-Split) gilt: Migration vor dem Merge gegen eine Kopie der
aktuellen Dev-Datenbank testen, nicht nur gegen eine frische Test-DB. Kein
Datenverlust erwartet (nur Gruppen-Umbenennung/-Zusammenlegung, keine
gelöschten personenbezogenen Daten).
