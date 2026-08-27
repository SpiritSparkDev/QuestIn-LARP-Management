# SC-/NSC-Profilfelder – Design

## Ziel

Konkretisiert zwei offene Punkte aus vorherigen Specs, angestoßen durch einen
Abgleich mit den Standardfeldern eines etablierten Con-Orga-Tools:

1. Das bisher schmale `DEFAULT_CHARACTER_SCHEMA` (SC-Charakterfelder) bekommt
   die fehlenden, in der Szene üblichen Felder ergänzt.
2. Das in `2026-08-26-gruppen-berechtigungen-design.md` nur grob skizzierte
   **NSC-Profilschema** wird hier vollständig konkretisiert (Tabellenform,
   Default-Feldliste, benötigte neue Feldtypen) – das ist die fehlende
   Grundlage für den noch ungeschriebenen Plan 4 ("NSC Profile") der
   Gruppen-&-Berechtigungen-Initiative.

Zusätzlich: ein neues, gruppenunabhängiges Account-Feld **Pronomen**.

Dieses Dokument ergänzt die Basis-Spec (`2026-08-24-teilnehmerregistrierung-
design.md`, Charakterschema) und die Gruppen-Spec (NSC-Profilschema-Sketch)
um konkrete Feldlisten und ein vollständiges Datenmodell. Alles andere aus
beiden bleibt unverändert gültig.

## Nicht-Ziele (YAGNI, bewusst ausgeklammert)

- Kein separates **Alter**-Feld – `birthdate` ist bereits ein bestehendes
  Account-Feld und deckt das ab; ein zusätzliches Alter-Feld wäre eine
  Redundanz mit potenziell widersprüchlichen Werten (Alter müsste bei jedem
  Con händisch nachgezogen werden, Geburtsdatum nicht).
- Kein eigenes Feld-Set für SC/GSC – bleibt bei der Gruppen-Spec-Entscheidung
  ("Eigene Feld-Sets für GSC/SC" explizit ausgeschlossen): nur NSC bekommt
  ein eigenes, globales Profilformular; SC/GSC nutzen weiterhin ausschließlich
  das per-Event `character_form_schema`.
- Keine Granularitäts-Feinjustierung der NSC-Skalen (3 vs. 5 Stufen etc.) –
  der unten definierte Default ist ein sinnvoller Startpunkt, danach über die
  künftige NSC-Schema-Verwaltung frei änderbar (analog zu Event-Charakter-
  schemas).
- Kein rückwirkendes Befüllen bestehender Charaktere/Profile mit den neuen
  Feldern – wie beim bestehenden Schema-Muster bleiben neue Felder bei
  Bestandsdaten einfach leer, bis aktiv ausgefüllt.
- Kein Admin-UI-Schema-Builder für das NSC-Profilschema in diesem Dokument
  festgelegt – ob Plan 4 einen (analog zum Event-Schema-Builder) oder erstmal
  nur den Default nutzt, ist Implementierungsdetail (siehe Offene Punkte).

## Architektur

### 1. Neue Feldtypen (`formFields.js` / `schemaValidation.js`)

Bisher unterstützt: `text`, `textarea`, `select`. Für die NSC-Skalen reicht
`select` (Optionen sind ohnehin eine freie String-Liste), aber zwei echte
Lücken bleiben:

- **`boolean`** – Checkbox. Für Ja/Nein-Felder (NSC: "Für Orgaanfragen
  offen?", "Als Hilfs-SL verfügbar?"). Wert wird als `true`/`false`
  gespeichert, `required` ergibt für Checkboxen keinen Sinn und wird beim
  Rendern ignoriert.
- **`multiselect`** – Checkbox-Gruppe über `field.options` (gleiche
  Options-Quelle wie `select`). Für Mehrfachauswahl (NSC: Ausrüstungs-/
  Rollen-Kategorien). Wert ist ein `string[]`.
- **`number`** – natives `<input type="number">`. Für SC: Erfahrungspunkte.
  Validierung: `typeof value === 'number'` (bzw. per `Number.isFinite`).

Alle drei sind generische Ergänzungen zu `formFields.js`/
`schemaValidation.js` und damit von Charakterschema **und**
NSC-Profilschema nutzbar – dieselbe Validierungslogik, kein Duplikat (wie
in der Gruppen-Spec für die Schema-Wiederverwendung bereits als Ziel
festgehalten).

### 2. SC-Charakterschema – Erweiterung von `DEFAULT_CHARACTER_SCHEMA`

Bestehend: `klasse`, `volk`, `religion`, `magischBegabt`, `conTage`. Neu:

| Key | Label | Typ | Required |
|---|---|---|---|
| `titel` | Titel | text | nein |
| `gesinnung` | Gesinnung | text | nein |
| `heimatland` | Heimatland | text | nein |
| `erfahrungspunkte` | Erfahrung (Punkte) | number | nein |
| `charakterVorlieben` | Charakter-Gerne | textarea | nein |
| `charaktergeschichte` | Charaktergeschichte/Wissenswertes | textarea | nein |
| `konfliktpotenzial` | Konfliktpotenzial | textarea | nein |

**Bewusst nicht übernommen:**
- **Gruppe** – bereits ein eigenes Feature (Gruppen-Relation), keine
  Duplizierung als Freitext-Schema-Feld.
- **Name** – bereits ein Top-Level-Feld des Charakters (`characters.name`),
  nicht Teil des dynamischen Schemas.

Wie bisher nur ein **Preset**: Events können das geladene Schema danach
frei anpassen/löschen/erweitern.

### 3. NSC-Profilschema – konkretisiert

Neue Tabelle `nsc_profile_schema` (eine einzige Zeile, analog zum
Seed-Muster von `groups`):

```sql
CREATE TABLE nsc_profile_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);
```

App-seitig immer genau eine Zeile (idempotent geseedet, wie
`db/seedGroups.js`), gelesen über `SELECT * FROM nsc_profile_schema LIMIT
1`. Löst den in der Gruppen-Spec offen gelassenen Punkt ("eigene 1-Zeilen-
Tabelle vs. generische `app_settings`-Tabelle") zugunsten der eigenen
Tabelle – eine generische Settings-Abstraktion für diesen einen Anwendungs-
fall wäre verfrüht (kein zweiter Nutzer für so etwas in Sicht).

`users` bekommt (wie in der Gruppen-Spec bereits festgelegt) eine Spalte
`nsc_data jsonb NOT NULL DEFAULT '{}'`.

Default-Schema liegt in neuer Datei `config/nscProfileDefaults.js` (gleiches
Muster wie `db/groupDefaults.js`/`frontend/js/defaultCharacterSchema.js`),
geseedet über `db/seedNscProfileSchema.js`:

| Key | Label | Typ | Options |
|---|---|---|---|
| `fuerOrgaanfragenOffen` | Für Orgaanfragen offen? | boolean | – |
| `alsHilfsSlVerfuegbar` | Als Hilfs-SL verfügbar? | boolean | – |
| `erfahrung` | Erfahrung | select | Anfänger, Fortgeschritten, Erfahren |
| `rollenbindung` | Rollenbindung | select | Springer, Mittel, Festrolle |
| `anfuehrerfaehigkeiten` | Anführerfähigkeiten | select | Untergebener, Mitläufer, Anführer |
| `sprechrollen` | Sprechrollen | select | Still, Wenige Sätze, Redner |
| `schauspieltalent` | Schauspieltalent | select | Statist, Mittel, Schauspieler |
| `kampferfahrung` | Kampferfahrung | select | Pazifist, Mittel, Veteran |
| `equipment` | Equipment | select | Wenig, Mittel, Viel |
| `improvisationsfaehigkeit` | Improvisationsfähigkeit | select | Weisungsgebunden, Mittel, Improvisationstalent |
| `sozialverhalten` | Sozialverhalten | select | Schüchtern, Mittel, Offenherzig |
| `belastbarkeit` | Belastbarkeit | select | Wenig, Mittel, Viel |
| `rollenAusruestung` | Ausrüstung/Vorliebe für Darstellung als | multiselect | Adel, Alchemist, Bauer, Handwerker, Dämon, Fay, Druide, Elf, Geist, Gelehrter, Herold, Hexe, Kämpfer (leicht), Kämpfer (Kettenhemd/Mittel), Kämpfer (Platte), Magier, Priester, Räuber/Bandit, Schamane, Fahrendes Volk, Kaufmann, Untoter (Höherer), Untoter (Niederer), Waldläufer |
| `darstellungsstaerken` | Was kann ich gut darstellen? | textarea | – |
| `einsatzwuensche` | Womit kann man mich beauftragen? | textarea | – |

(Die letzten beiden Felder waren bereits als Beispiel in der Gruppen-Spec
genannt, hier nur in die vollständige Liste übernommen. Tippfehler in der
Vorlage korrigiert: "Untertoter (Höherer)" → "Untoter (Höherer)".)

### 4. Neues Account-Feld: Pronomen

Freitext (kein Enum – Pronomen-Sets sind zu vielfältig für eine feste
Liste), verschlüsselt wie die bestehenden Account-Felder:

- `users.pronomen_enc bytea` (neue Migration).
- `backend/accounts/repository.js`: `SELECT_COLUMNS`, `decryptAccount`,
  `updateAccount` um `pronomen`/`pronomen_enc` erweitert – gleiches Muster
  wie `phone`.
- `db/groupDefaults.js`: `accountFields` von `admin` und `orga` um
  `'pronomen'` ergänzt (gleiche Behandlung wie die bestehenden PII-Felder;
  jede Person darf ihr eigenes Pronomen-Feld ohnehin uneingeschränkt selbst
  bearbeiten, siehe Gruppen-Spec-Grundsatz zu eigenen Daten).
- `invitations`-Tabelle (aus `2026-08-27-mitgliederverwaltung-einladungen-
  design.md`, noch nicht implementiert): `pronomen_enc bytea` ergänzen, da
  diese Tabelle die vorausfüllbaren Account-Felder 1:1 spiegelt.
- `frontend/account.html`: neues Eingabefeld, analog zu den bestehenden
  verschlüsselten Feldern.

## Backend-Durchsetzung

Migrationen (neue Datei `db/migrations/007_profile_fields.sql`):

```sql
ALTER TABLE users ADD COLUMN pronomen_enc bytea;
ALTER TABLE users ADD COLUMN nsc_data jsonb NOT NULL DEFAULT '{}';

CREATE TABLE nsc_profile_schema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema jsonb NOT NULL DEFAULT '[]'
);
```

`GET /nsc-schema` (bereits in der Gruppen-Spec als Endpunkt vorgesehen)
liefert die eine Zeile aus `nsc_profile_schema`; `PUT /nsc-schema`
(admin-only) überschreibt sie – Validierung über dieselbe, jetzt um
`boolean`/`multiselect`/`number` erweiterte `schemaValidation.js`-Logik.

`PATCH /account` (bestehender Endpunkt) wird um `pronomen` und – nur
relevant/sichtbar für die `nsc`-Gruppe – `nscData` erweitert, validiert
gegen das aktuelle `nsc_profile_schema` genau wie Charakterdaten gegen
`character_form_schema`.

## Frontend

- `frontend/js/formFields.js`: `renderField` um `boolean` (Checkbox,
  `checked`-Attribut statt `value`) und `multiselect` (mehrere Checkboxen
  mit gleichem `name[]`, vorbelegt aus `value` als Array) erweitert;
  `type="number"` für `number`-Felder.
- `frontend/js/defaultCharacterSchema.js`: um die neuen SC-Felder ergänzt.
- Neue `config/nscProfileDefaults.js` + `db/seedNscProfileSchema.js`
  (Backend-seitig, analog `groupDefaults.js`/`seedGroups.js`).
- `frontend/account.html`: neues Pronomen-Feld bei den bestehenden
  verschlüsselten Feldern; neuer NSC-Abschnitt (nur gerendert wenn
  `account.group.key === 'nsc'`, wie in der Gruppen-Spec vorgesehen),
  gerendert über `renderField` gegen `GET /nsc-schema`.

## Testing

- Unit-Tests für `formFields.js` (neue Feldtypen rendern korrekt,
  escapen weiterhin XSS-sicher) und `schemaValidation.js` (boolean/
  multiselect/number-Validierung, inkl. Ablehnung falscher Typen).
- Migrationstest: `nsc_profile_schema`-Tabelle existiert und enthält nach
  dem Seed genau eine Zeile; `users.pronomen_enc`/`users.nsc_data`
  existieren.
- Integrationstest für `PATCH /account` mit `pronomen`/`nscData`
  (Verschlüsselung/Entschlüsselung round-trip, Validierung gegen
  `nsc_profile_schema`).
- Wie immer: letzte Aufgabe der Umsetzung führt die volle `npm test`-Suite
  aus, nicht nur den betroffenen Teilbereich (siehe Prozess-Lehre aus
  Plan "Group Management UI").

## Offene Punkte für die Umsetzung (kein Blocker für die Spec)

- Ob es für das NSC-Profilschema einen eigenen Admin-Schema-Builder gibt
  (analog zum Event-Charakterschema-Editor) oder Plan 4 erstmal nur den
  Default nutzt und ein Builder später nachgezogen wird, ist eine
  Umsetzungsentscheidung, kein Design-Blocker.
- Exakte Stufen-Bezeichnungen der NSC-Skalen (aktuell 3-stufig: Minimum,
  Mitte, Maximum je Kategorie) sind ein sinnvoller Startpunkt, kein
  Endzustand – über die künftige Schema-Verwaltung frei änderbar.
- Dieses Dokument liefert die fachliche/daten­modellseitige Grundlage für
  den noch ungeschriebenen Plan 4 ("NSC Profile") der Gruppen-&-
  Berechtigungen-Initiative; die eigentliche Task-Zerlegung erfolgt beim
  Schreiben dieses Plans.
