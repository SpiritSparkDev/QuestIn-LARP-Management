# Mitgliederverwaltung & Einladungen – Design

## Ziel

Baut auf `docs/superpowers/specs/2026-08-26-gruppen-berechtigungen-design.md`
auf (Plan 3 der dort skizzierten 4-Plan-Sequenz). Dieses Dokument
finalisiert die dort schon grob umrissene Mitgliederverwaltung
(`GET/POST /members`, `PATCH /members/:id`, `admin/members.html`) und
spezifiziert zusätzlich einen komplett neuen Baustein: **Einladungslinks**
– Admin/Orga legt ein neues Mitglied mit vorausgefüllten Feldern an, ohne
dass die Person sich selbst registrieren muss; sie setzt beim ersten Login
nur noch ihr Passwort.

## Nicht-Ziele (YAGNI, bewusst ausgeklammert)

- Alles bereits in der Basis-Spec ausgeschlossene bleibt ausgeschlossen
  (Suche/Filter, Konto deaktivieren/löschen, feld-genaue Charakter-Rechte).
- Einladungen sind unbegrenzt oft erneut versendbar, aber es gibt keine
  Liste "verschickter Einladungshistorie" – nur der aktuelle offene Stand
  pro eingeladener E-Mail-Adresse.
- Kein Bulk-Import (z. B. CSV mit vielen Einladungen auf einmal).
- Charaktere können bei einer Einladung nicht mit vorausgefüllt werden –
  nur Account-Felder. Charaktere legt die Person selbst nach dem ersten
  Login an, wie jeder andere Nutzer auch.

## Auflösung eines offenen Punkts aus der Basis-Spec

Die Basis-Spec ließ offen, ob `name` über die Mitgliederverwaltung änderbar
sein soll (aktuell nicht Teil der `account_fields`-Liste). Für Einladungen
ist das kein Sonderfall: `name` ist beim Anlegen einer Einladung ein
**Pflichtfeld, unabhängig von den `account_fields`-Rechten der einladenden
Gruppe** (genau wie beim regulären `/auth/register`-Endpunkt schon heute).
Für das Bearbeiten *bestehender* Mitglieder über `PATCH /members/:id`
bleibt es bei der Basis-Spec: `name` ist weiterhin nicht editierbar. Diese
Asymmetrie ist bewusst – beim Einladen existiert noch keine "eigene"
Entscheidung der Person, die überschrieben werden könnte.

## Architektur

### Datenmodell

Neue Tabelle `invitations`:

```sql
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text UNIQUE NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  group_id uuid NOT NULL REFERENCES groups(id),
  address_enc bytea,
  birthdate_enc bytea,
  phone_enc bytea,
  emergency_contact_enc bytea,
  medical_notes_enc bytea,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz
);
CREATE INDEX invitations_email_idx ON invitations (email) WHERE redeemed_at IS NULL;
```

Bewusst eine **separate Tabelle**, kein "unvollständiger" `users`-Datensatz
mit `password_hash = NULL` (Alternative wurde erwogen und verworfen) – so
existiert nie ein `users`-Eintrag, der nicht wirklich eingeloggt werden
kann, und die Mitgliederliste muss nicht zwischen "echten" und
"unvollständigen" User-Zeilen unterscheiden.

Die vorausfüllbaren Felder liegen verschlüsselt (`encryptField`, gleiche
Funktion wie bei `users`) – auch *vor* der Account-Erstellung dürfen
sensible Daten wie Gesundheitshinweise nie im Klartext in der DB stehen.
Bei Einlösung werden sie 1:1 (verschlüsselt, kein Um-Verschlüsseln nötig,
da `encryptField`/`decryptField` mit demselben `ENCRYPTION_KEY` arbeiten)
in die neue `users`-Zeile übernommen.

`email` ist bewusst *nicht* `UNIQUE` auf Tabellenebene (mehrere abgelaufene/
verworfene Einladungen an dieselbe Adresse dürfen nebeneinander existieren,
z. B. nach mehrfachem "Erneut senden" – siehe unten), aber der partielle
Index über nicht eingelöste Zeilen hilft der "gibt es schon eine offene
Einladung für diese E-Mail"-Abfrage.

### Einladungs-Lebenszyklus

1. **Erstellen**: Admin/Orga füllt Formular aus (Name, E-Mail, Gruppe,
   die laut eigenen `account_fields`-Rechten editierbaren Account-Felder).
   Backend erzeugt Token (`crypto.randomBytes(32).toString('hex')`, exakt
   wie bei Verifizierung/Passwort-Reset), speichert die Zeile, TTL 7 Tage,
   verschickt E-Mail über `mailer.js` (neue Funktion `sendInvitationEmail`,
   gleiches Muster wie `sendVerificationEmail`/`sendPasswordResetEmail`).
   Existiert bereits ein `users`-Eintrag mit dieser E-Mail: 409 (kann nicht
   doppelt eingeladen werden, dafür gibt es Mitgliederverwaltung/PATCH).
2. **Einlösen** (`set-password.html?token=...`, neue Seite): Person setzt
   ein Passwort. Backend prüft Token (existiert, nicht abgelaufen, nicht
   schon eingelöst), legt **atomar** (eine Transaktion) die `users`-Zeile
   an (`email_verified = true` – das Öffnen des per E-Mail verschickten
   Links beweist bereits Zugriff auf das Postfach, kein zusätzlicher
   Verifizierungsschritt nötig), setzt `password_hash`, markiert die
   Einladung `redeemed_at = now()`, startet eine Session (Person ist direkt
   eingeloggt, wie nach normaler Registrierung+Verifizierung).
3. **Erneut senden**: Admin/Orga kann eine noch nicht eingelöste Einladung
   erneut verschicken – neuer Token wird generiert (alter Token wird damit
   ungültig, `UPDATE invitations SET token = ..., expires_at = ... WHERE
   id = $1 AND redeemed_at IS NULL`), gleiche E-Mail erneut verschickt.
4. **Ablauf**: Kein Hintergrundjob nötig – eine abgelaufene, nicht
   eingelöste Einladung wird beim Einlöse-Versuch einfach als "ungültig"
   abgelehnt (gleiches Muster wie Passwort-Reset-Token). Sie bleibt in der
   Tabelle stehen (keine automatische Löschung), taucht aber in der
   Mitgliederliste weiterhin als "Eingeladen" auf, mit Möglichkeit zum
   erneuten Versenden.

## Backend-Durchsetzung

Alle folgenden Endpunkte `requireMenu('mitglieder')` (wie in der Basis-Spec
für `/members` festgelegt):

- `GET /members` – liefert eine **zusammengeführte** Liste: reale
  Mitglieder (`users`, wie in der Basis-Spec: `id`, `name`, `email`,
  Gruppenname) plus offene, nicht abgelaufene Einladungen (`invitations`
  ohne `redeemed_at`), jeweils mit einem `status`-Feld
  (`'active' | 'invited'`) zur Unterscheidung in der UI. Abgelaufene,
  nie eingelöste Einladungen werden in der Liste weiterhin als
  `'invited'` geführt (nicht stillschweigend ausgeblendet) – der Admin
  soll sehen, dass hier noch eine Aktion (erneut senden) offen ist.
- `GET /members/:id` – wie Basis-Spec (nur für echte `users`-Einträge).
- `PATCH /members/:id` – wie Basis-Spec.
- `POST /members/invite` – Payload: `{ email, name, group?, ...
  Account-Felder }`. Server filtert die Payload exakt wie bei
  `PATCH /members/:id` gegen die `account_fields` der aufrufenden Gruppe
  (400 bei nicht erlaubtem Feld) – **`group` eingeschlossen**: eine Gruppe
  ohne `"group"` in ihren eigenen `account_fields` (z. B. Orga per Default)
  darf einer brandneuen Einladung keine höhere Gruppe zuweisen, nur weil
  der Account noch nicht existiert – dieselbe Regel wie beim nachträglichen
  Ändern über `PATCH`. Wird `group` weggelassen, landet die Einladung ohne
  Fehler in der Default-Gruppe `sc`. Nur `name`/`email` sind unconditional
  Pflichtfelder ohne `account_fields`-Check (siehe Abschnitt oben zu
  `name`). 409 falls bereits ein `users`-Eintrag mit dieser E-Mail
  existiert.
- `POST /members/invitations/:id/resend` – nur für nicht eingelöste
  Einladungen (404/409 sonst), neuer Token + TTL, erneuter Mailversand.
- `POST /auth/invite/redeem` – öffentlich (kein Login nötig, wie
  `/auth/password-reset/confirm`): `{ token, password }`. Führt den
  Einlöse-Schritt aus (siehe Lebenszyklus oben), setzt die Session-Cookie
  in der Response wie `/auth/login`.

## Frontend

- `frontend/admin/members.html` (aus der Basis-Spec, jetzt konkretisiert):
  Everest-Registry-Theme, gleiches Sidebar-Shell wie
  `events.html`/`checkin.html`/`groups.html`. Liste zeigt Name, E-Mail,
  Gruppe, Status (`Aktiv` / `Eingeladen`-Badge). Klick auf einen aktiven
  Eintrag öffnet die Detailansicht (wie Basis-Spec: erlaubte Felder als
  Eingabefelder, nicht erlaubte als reiner Text, Charakterliste nur
  lesbar). Klick auf einen eingeladenen Eintrag zeigt stattdessen nur
  einen "Erneut senden"-Button. Ein "Neues Mitglied einladen"-Formular
  (gleiche Feldauswahl wie die Detailansicht: Name, E-Mail, Gruppe, die
  editierbaren Account-Felder) steht der Liste voran, analog zum
  Create-Form-Muster in `events.html`/`groups.html`.
- `frontend/set-password.html` (neu): Token aus der URL, ein
  Passwort-Feld, Submit ruft `POST /auth/invite/redeem`, leitet bei Erfolg
  zu `/account.html` weiter (Person ist eingeloggt). Bei ungültigem/
  abgelaufenem Token: Fehlermeldung, kein Formular. Gleiche Themenwahl wie
  die anderen Auth-Seiten (`login.html`, `reset-password.html`) –
  Chronicle & Crest, da eine neu eingeladene Person eine Teilnehmerin ist,
  keine Admin-Ansicht.

## Testing

- Integrationstests für `POST /members/invite` (Feld-Filterung wie bei
  `PATCH /members/:id`, 409 bei bereits existierender E-Mail),
  `POST /members/invitations/:id/resend` (Token ändert sich, alter Token
  wird ungültig), `POST /auth/invite/redeem` (Erfolgsfall: Session
  gesetzt, `email_verified = true`, Felder korrekt übernommen und
  entschlüsselbar; Fehlerfälle: abgelaufen, schon eingelöst, unbekannter
  Token).
- `GET /members` bekommt einen Test, der bestätigt, dass offene
  Einladungen mit `status: 'invited'` erscheinen und eingelöste/
  abgelaufene Einladungen sich korrekt verhalten (eingelöst: verschwindet
  aus der Liste, echtes Mitglied taucht stattdessen auf; abgelaufen:
  bleibt als `'invited'` sichtbar).
- Migration bekommt einen Test analog zum bestehenden Muster
  (`schema-users.test.js`): `invitations`-Tabelle existiert nach
  `runMigrations()`.
- `set-password.html` wird wie üblich manuell per Browser-Tooling
  verifiziert (kein DOM-Test-Framework in diesem Stack).

## Offene Punkte für die Umsetzung (kein Blocker für die Spec)

- Exakter Wortlaut der Einladungs-E-Mail (Betreff/Text) ist ein
  Umsetzungsdetail, keine Design-Entscheidung – orientiert sich am Stil
  der bestehenden Verifizierungs-/Reset-Mails.
- Ob `admin/members.html`s Detailansicht als eigener Seitenbereich oder
  als Inline-Erweiterung der Zeile umgesetzt wird, ist ein UI-
  Implementierungsdetail (Muster: `events.html`s Edit-Formular unterhalb
  der Liste, wiederverwendbar).
