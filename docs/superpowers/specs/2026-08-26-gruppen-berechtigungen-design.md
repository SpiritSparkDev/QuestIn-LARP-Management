# Gruppen & Berechtigungen – Design

## Ziel

Das bisherige starre 3-Rollen-System (`participant` / `checkin_helper` /
`admin`, als DB-Check-Constraint) wird durch konfigurierbare, in der
Datenbank verwaltete **Gruppen** ersetzt. Jede Gruppe legt fest, welche
Menüs (Seiten) sichtbar sind und welche Felder anderer Mitglieder sie in
einer neuen Mitgliederverwaltung bearbeiten darf. Es gibt acht vordefinierte
Gruppen (Admin, Orga, Plot-Orga, SL, Hilfs-SL, NSC, GSC, SC) mit sinnvollen
Default-Rechten, aber Admins können jederzeit weitere Gruppen anlegen und
Rechte anpassen. NSC-Nutzer bekommen zusätzlich ein eigenes, von Events
unabhängiges Profil-Formular.

Dieses Dokument ersetzt/erweitert die "Rollen & Endpunkte"-Abschnitte des
ursprünglichen Specs (`2026-08-24-teilnehmerregistrierung-design.md`) für
alles, was Rollen/Rechte betrifft. Alle anderen Teile des ursprünglichen
Specs (Verschlüsselung, Auth, Charakter-/Event-System) bleiben unverändert
gültig.

## Nicht-Ziele (YAGNI, bewusst ausgeklammert)

- Suche/Filter in der Mitgliederliste.
- Konto deaktivieren/löschen.
- Eine "sichtbar, aber nicht bearbeitbar"-Zwischenstufe für Account-Felder
  über das beschriebene Verhalten hinaus (nicht erlaubte Felder werden in
  der Detailansicht schlicht als Text statt als Eingabefeld angezeigt).
- Feld-genaue Rechte für Charakter-Felder (bewusst ein einziges
  Ja/Nein-Recht "darf Charaktere anderer bearbeiten" statt einer
  Feld-Allowlist, da Charakter-Schemas pro Event frei definierbar sind und
  eine Default-Liste für zukünftige, noch unbekannte Feld-Keys nicht
  sinnvoll vorbelegt werden kann).
- Eigene Feld-Sets für GSC/SC (nur NSC bekommt ein eigenes Formular).
- Menü-Rechte feingranularer als "ganze Seite sichtbar/aufrufbar oder
  nicht" (keine einzelnen Aktionen innerhalb einer Seite einzeln
  freischaltbar).
- Rechte, die das Bearbeiten der **eigenen** Daten einschränken – jede*r
  darf weiterhin uneingeschränkt die eigenen Account-/Charakterdaten
  bearbeiten, unabhängig von der Gruppe. Feld-Rechte gelten ausschließlich
  für die Mitgliederverwaltung (fremde Daten).

## Architektur

### Datenmodell

Neue Tabelle `groups`:

```sql
CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,          -- slug, z.B. 'admin', 'orga', frei bei neuen Gruppen
  name text NOT NULL,                -- Anzeigename
  visible_menus jsonb NOT NULL DEFAULT '[]',   -- string[] aus: konto, charaktere, mitglieder, events, checkin
  account_fields jsonb NOT NULL DEFAULT '[]',  -- string[] aus den editierbaren Account-Feld-Keys (inkl. optional "group")
  can_edit_characters boolean NOT NULL DEFAULT false,
  is_protected boolean NOT NULL DEFAULT false  -- true nur für die 'admin'-Gruppe, siehe unten
);
```

`users.role` (Check-Constraint-Spalte) wird ersetzt durch
`users.group_id uuid NOT NULL REFERENCES groups(id)`.

Editierbare Account-Feld-Keys (fest, nicht dynamisch): `address`,
`birthdate`, `phone`, `emergencyContact`, `medicalNotes`, plus der
Pseudo-Feld-Key `"group"` (steuert, ob die Gruppe eines Mitglieds über die
Mitgliederverwaltung änderbar ist). `name` ist absichtlich nicht in dieser
Liste enthalten (wie bisher: nur der Account-Owner ändert seinen Namen,
oder generell nicht Teil der Mitgliederverwaltung – siehe Offene Punkte).

Die `admin`-Gruppe ist besonders geschützt (`is_protected = true`):
nicht löschbar, ihre Rechte sind über die UI nicht editierbar (immer alle
Menüs, alle Felder, `can_edit_characters = true`), um ein Aussperren zu
verhindern.

`config/groupDefaults.js` (neue Datei, gleiches Muster wie
`frontend/js/defaultCharacterSchema.js`) enthält die Default-Werte für die
acht vordefinierten Gruppen (siehe Tabelle unten). Diese Datei wird
**einmalig** von einer Migration gelesen, um die `groups`-Tabelle beim
ersten Deploy zu befüllen (analog zum bestehenden `seedAdmin.js`-Muster,
idempotent: existiert eine Gruppe mit gleichem `key` schon, wird sie nicht
überschrieben). Ab dann lebt der tatsächliche Zustand ausschließlich in der
DB und ist über die neue Gruppen-Verwaltungsseite änderbar – inklusive dem
Anlegen komplett neuer, freier Gruppen (die dann leer starten: keine
Menüs, keine Felder, bis der Admin sie konfiguriert).

### Default-Rechte-Tabelle

| Gruppe (`key`) | `visible_menus` | `account_fields` | `can_edit_characters` |
|---|---|---|---|
| `admin` | konto, charaktere, mitglieder, events, checkin | address, birthdate, phone, emergencyContact, medicalNotes, group | true |
| `orga` | konto, charaktere, mitglieder, events, checkin | address, birthdate, phone, emergencyContact, medicalNotes | true |
| `plot_orga` | konto, charaktere, events, checkin | – | false |
| `sl` | konto, charaktere, checkin | – | false |
| `hilfs_sl` | konto, charaktere, checkin | – | false |
| `nsc` | konto, charaktere | – | false |
| `gsc` | konto, charaktere | – | false |
| `sc` | konto, charaktere | – | false |

Migration bestehender Nutzer (alter `role`-Wert → neue Gruppe): `admin` →
`admin`, `checkin_helper` → `sl`, `participant` → `sc`. Neue,
selbstregistrierte Nutzer bekommen künftig standardmäßig die Gruppe `sc`
(vorher: `participant`).

### NSC-Profil-Schema

Analog zu `events.character_form_schema`, aber global und unabhängig von
Events: eine Zeile/Setting `nsc_profile_schema jsonb` (z. B. in einer
kleinen `app_settings`-Tabelle mit einer festen Zeile, oder als eigene
1-Zeilen-Tabelle `nsc_profile_schema` – Implementierungsdetail, keine
Design-Entscheidung). Gleiche Feld-Struktur wie Charakter-Schemas
(`{key, label, type, required, options}`), verwaltet über dieselbe
Validierungslogik wie `backend/events/schemaValidation.js` (wird dafür
generisch nutzbar gemacht, kein Duplikat).

`users` bekommt eine Spalte `nsc_data jsonb NOT NULL DEFAULT '{}'` für die
individuellen Antworten. Nur relevant/sichtbar, wenn die Gruppe des Nutzers
`key = 'nsc'` ist. Kein Bezug zu Events, Registrierung oder Check-In.
Default-Vorlage für `nsc_profile_schema` (Startbefüllung, danach frei
änderbar) liegt ebenfalls in `config/groupDefaults.js`, z. B. Felder wie
"Was kann ich gut darstellen?" (textarea), "Womit kann man mich
beauftragen?" (textarea).

## Backend-Durchsetzung

- `backend/middleware/authorize.js`s `requireRole(...roles)` wird ersetzt
  durch `requireMenu(menuKey)`: lädt die Gruppe des angemeldeten Nutzers
  (`user.group_id` → `groups.visible_menus`) und prüft, ob `menuKey`
  enthalten ist. Dieselbe DB-gestützte Quelle wie das Frontend-Menü – das
  Verstecken eines Nav-Links ist nie der einzige Schutz.
  - `backend/events/routes.js`: `requireRole('admin')` → `requireMenu('events')`.
  - `backend/registrations/routes.js` (Check-In-Endpunkte): `requireRole('admin', 'checkin_helper')` → `requireMenu('checkin')`.
- Neue Endpunkte, alle `requireMenu('mitglieder')`:
  - `GET /members` – Liste: `id`, `name`, `email`, Gruppenname.
  - `GET /members/:id` – Detail: entschlüsselte Account-Felder, Gruppe,
    Charakterliste des Mitglieds (immer nur lesbar in dieser Ansicht),
    `nsc_data` falls Gruppe = `nsc`.
  - `PATCH /members/:id` – Payload wird gegen `account_fields` der
    aufrufenden Gruppe geprüft. Enthält die Payload einen Key außerhalb
    dieser Allowlist, wird die gesamte Anfrage mit 400 abgelehnt (nicht
    stillschweigend gefiltert) – konsistent mit dem bestehenden expliziten
    Validierungsstil der Codebase.
- Gruppen- und NSC-Schema-Verwaltung sind **fest** auf die `admin`-Gruppe
  beschränkt (nicht selbst über das Rechte-System konfigurierbar – sonst
  Henne-Ei-Problem "wer darf festlegen, wer festlegen darf"):
  - `GET/POST/PUT /groups` – Gruppen auflisten/anlegen/bearbeiten.
  - `GET/PUT /nsc-schema` – NSC-Profil-Schema lesen/ändern
    (`GET` zusätzlich für die eigene NSC-Gruppe selbst erreichbar, um das
    Formular auf `account.html` zu rendern).
- `GET /account` liefert künftig zusätzlich `menus: string[]` (die
  `visible_menus` der eigenen Gruppe) und `group: { key, name }`, damit das
  Frontend das Menü rendern kann, ohne eine zweite Anfrage zu brauchen.

## Frontend

- `frontend/js/nav.js` (neu): eine Menü-Key→{label, href}-Tabelle plus
  `renderNav(menus, currentPath)`. Ersetzt die im letzten Plan eingeführte
  Ad-hoc-Rollenprüfung (`ADMIN_NAV_LINKS`/`account.role === 'admin'`) auf
  allen neun bestehenden Seiten durch einen einzigen, menügetriebenen
  Mechanismus. Löst nebenbei den ursprünglichen Wunsch "vom Admin-Bereich
  zurück in den normalen Bereich" – die `admin`-Gruppe hat `konto` und
  `charaktere` ebenfalls in ihren `visible_menus`, taucht also automatisch
  im eigenen Nav auf.
- `frontend/admin/members.html` (neu, Everest-Registry-Theme, gleiches
  Sidebar-Shell wie `events.html`/`checkin.html`): Liste + Detailansicht.
  In der Detailansicht: erlaubte Felder als Eingabefelder, nicht erlaubte
  als reiner Text; Charakterliste des Mitglieds nur lesbar; NSC-Bereich
  falls zutreffend.
- `frontend/admin/groups.html` (neu, `admin`-only): Gruppen auflisten, neue
  anlegen, pro Gruppe Menüs/Felder/`can_edit_characters` per Checkboxen
  bearbeiten. Für die geschützte `admin`-Gruppe sind die Checkboxen
  deaktiviert (nur Anzeige).
- `frontend/account.html`: neuer NSC-Abschnitt, nur gerendert wenn
  `account.group.key === 'nsc'`, über `renderField`/`formFields.js` gegen
  das von `GET /nsc-schema` gelieferte Schema, gespeichert über eine
  Erweiterung von `PATCH /account` um ein `nscData`-Feld.

## Testing

- Unit-Tests für `requireMenu` (Middleware) und die Feld-Filter-Logik in
  `PATCH /members/:id` (analog zu bestehenden Middleware-/Validierungstests).
- Integrationstests für die neuen `/members`-, `/groups`- und
  `/nsc-schema`-Endpunkte über mehrere Gruppen hinweg (Muster wie
  `characters.test.js`/`events.test.js`).
- Migration (`role` → `group_id`) bekommt einen Integrationstest, der
  prüft, dass bestehende `admin`/`checkin_helper`/`participant`-Nutzer nach
  der Migration in den korrekten neuen Gruppen landen.
- Die neuen HTML-Seiten werden wie bisher manuell per Browser-Tooling
  verifiziert (kein DOM-Test-Framework in diesem Stack).

## Offene Punkte für die Umsetzung (kein Blocker für die Spec)

- Ob `name` in der Mitgliederverwaltung überhaupt änderbar sein soll (aktuell
  nicht in der Account-Feld-Liste vorgesehen) – kann bei Bedarf während der
  Umsetzung als zusätzlicher Feld-Key ergänzt werden, ohne das Datenmodell
  zu ändern.
- Exakte Tabellenform für `nsc_profile_schema` (eigene 1-Zeilen-Tabelle vs.
  generische `app_settings`-Tabelle) ist ein Implementierungsdetail, das im
  Plan entschieden wird.
- Die Default-Rechte-Tabelle ist ein sinnvoller Startpunkt, kein
  Endzustand – nach Umsetzung über die Gruppen-Verwaltungsseite frei
  anpassbar.
