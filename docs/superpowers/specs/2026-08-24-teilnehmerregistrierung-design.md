# LARP Teilnehmerregistrierung – Design

Status: Approved
Datum: 2026-08-24

## Ziel

Web-App zur Registrierung von Teilnehmern für LARP-Events. Interessierte
legen ein Konto mit OT-Stammdaten an, erstellen darüber Charaktere und melden
sich mit diesen zu Events an. Admins verwalten Events und je Event ein
konfigurierbares Charakterformular. Vor Ort checken Admins/Check-In-Helfer
Teilnehmer anhand einer Liste ein und aus.

## Nicht-Ziele (YAGNI, bewusst ausgeklammert)

- Zahlungsabwicklung / Bezahlstatus
- Mehrsprachigkeit (nur Deutsch)
- Automatische E-Mail-Erinnerungen, Newsletter
- Rollen jenseits von `participant` / `checkin_helper` / `admin`
- Mobile Apps – nur responsive Web

## Architektur

```
Browser (Vanilla JS, mehrere HTML-Seiten)
        │ fetch() / JSON REST
        ▼
Node.js-Backend (nur node:http + node:*-Module, kein Web-Framework)
        │ pg (node-postgres)
        ▼
PostgreSQL
```

- **Frontend**: Mehrere eigenständige HTML-Seiten statt SPA-Router
  (`login.html`, `register.html`, `account.html`, `characters.html`,
  `admin/events.html`, `admin/checkin.html` …). Jede Seite lädt ein
  `<script type="module">`, das per `fetch` die REST-API anspricht. Kein
  Build-Step, kein Bundler nötig – Browser laden ES-Module nativ.
- **Backend**: Ein Node-Prozess, Routing über eine simple manuelle
  Pfad/Methode-Tabelle (kein Express). Sessions serverseitig, Cookie-basiert.
- **Datenbank**: PostgreSQL. Zugriff über `pg`, keine ORM (Queries sind
  überschaubar genug für rohes SQL mit parametrisierten Statements).
- **Deployment**: Docker Compose mit zwei Services (`app`, `db`). TLS wird
  von einem Reverse Proxy vor dem Compose-Stack terminiert (außerhalb des
  Scopes dieses Projekts).

## Datenmodell

```sql
users (
  id                  uuid primary key,
  email               text unique not null,
  password_hash       text,                     -- null bei reinen OAuth-Konten
  role                text not null check (role in ('participant','admin','checkin_helper')),
  email_verified      boolean not null default false,
  name                text not null,           -- Klartext (Anzeige, Login-Kontext)
  address_enc         bytea,                    -- verschlüsselt
  birthdate_enc       bytea,                    -- verschlüsselt
  phone_enc           bytea,                    -- verschlüsselt
  emergency_contact_enc bytea,                   -- verschlüsselt (Name+Telefon als JSON)
  medical_notes_enc   bytea,                    -- verschlüsselt (Allergien/Gesundheitshinweise)
  created_at          timestamptz not null default now()
)

oauth_accounts (
  id               uuid primary key,
  user_id          uuid references users(id) on delete cascade,
  provider         text not null check (provider in ('google','facebook','discord')),
  provider_user_id text not null,
  created_at       timestamptz not null default now(),
  unique (provider, provider_user_id)
)

email_verification_tokens (
  token       text primary key,
  user_id     uuid references users(id) on delete cascade,
  expires_at  timestamptz not null
)

password_reset_tokens (
  token       text primary key,
  user_id     uuid references users(id) on delete cascade,
  expires_at  timestamptz not null
)

sessions (
  token       text primary key,
  user_id     uuid references users(id) on delete cascade,
  expires_at  timestamptz not null
)

events (
  id                     uuid primary key,
  name                   text not null,
  event_date             date not null,
  character_form_schema  jsonb not null default '[]',
  -- Schema-Beispiel: [{"key":"fraction","label":"Fraktion","type":"text","required":true}, ...]
  created_at             timestamptz not null default now()
)

registrations (
  user_id       uuid references users(id) on delete cascade,
  event_id      uuid references events(id) on delete cascade,
  status        text not null check (status in ('registered','checked_in','checked_out')) default 'registered',
  checked_in_at  timestamptz,
  checked_out_at timestamptz,
  primary key (user_id, event_id)
)

characters (
  id        uuid primary key,
  user_id   uuid references users(id) on delete cascade,
  event_id  uuid references events(id) on delete cascade,
  name      text not null,
  data      jsonb not null default '{}',  -- entspricht events.character_form_schema
  created_at timestamptz not null default now()
)
```

**Warum JSONB fürs Charakterformular**: Der Admin definiert das Schema pro
Event, ohne dass eine Migration nötig ist. Validierung (Pflichtfelder,
erlaubte Typen) passiert serverseitig beim Speichern eines Charakters gegen
`events.character_form_schema`.

## Verschlüsselung sensibler Felder

- Betroffene Felder: `address`, `birthdate`, `phone`, `emergency_contact`,
  `medical_notes`.
- **App-seitig**, nicht per `pgcrypto`: Der Schlüssel bleibt im
  Node-Prozess (aus Docker Secret / ENV-Variable `ENCRYPTION_KEY`, 32 Byte)
  statt in SQL-Statements/Logs sichtbar zu werden.
- Algorithmus: AES-256-GCM über Node's eingebautes `crypto`-Modul. Pro Feld
  wird ein zufälliger 12-Byte-IV erzeugt; gespeichert wird
  `iv || authTag || ciphertext` als `bytea`.
- Ein zentrales Modul `backend/crypto/fieldCrypto.js` kapselt
  `encryptField(plaintext)` / `decryptField(buffer)`. Alle Stellen, die auf
  diese Spalten zugreifen, gehen ausschließlich über dieses Modul.
- `name` und `email` bleiben Klartext (werden für Login, Anzeige,
  Teilnehmerlisten gebraucht).
- Rollenbasierte Sichtbarkeit: Die API liefert `checkin_helper` diese
  Spalten grundsätzlich nicht aus (siehe unten), unabhängig von der
  Verschlüsselung – Verschlüsselung schützt zusätzlich bei DB-Kompromittierung.

## Auth

**E-Mail + Passwort**
- Registrierung: E-Mail + Passwort. Passwort-Hashing mit Node's
  `crypto.scrypt` (stdlib, kein bcrypt-Dependency).
- Nach Registrierung: Verifizierungs-Mail mit Token
  (`email_verification_tokens`, 24h gültig). Login ohne Verifizierung wird
  abgelehnt.
- Passwort-Reset: Token per Mail (`password_reset_tokens`, 1h gültig).
- Mailversand über SMTP mittels `nodemailer` (einzige Dependency für diesen
  Teil – Mail-Handling selbst zu bauen lohnt sich nicht).

**OAuth (Google, Facebook, Discord)** – zusätzlich zu E-Mail+Passwort, kein
Ersatz.
- Alle drei Provider sprechen im Kern denselben OAuth2-Authorization-Code-Flow.
  Ein generisches `backend/auth/oauth.js` kapselt den Ablauf, konfiguriert
  pro Provider mit `{ authUrl, tokenUrl, userInfoUrl, clientId, clientSecret,
  scope }` – kein Provider-SDK/Dependency nötig, `fetch` (nativ in Node)
  reicht für Token- und Userinfo-Requests.
- Flow: `GET /auth/oauth/:provider/start` erzeugt ein zufälliges `state`
  (CSRF-Schutz), legt es kurzlebig als `HttpOnly`-Cookie ab und redirected
  zur Consent-Seite des Providers. `GET /auth/oauth/:provider/callback`
  prüft `state` gegen das Cookie, tauscht den Code gegen ein Access-Token,
  holt E-Mail + Provider-User-ID vom Provider ab.
- Konto-Zuordnung: Existiert bereits ein `oauth_accounts`-Eintrag für
  `(provider, provider_user_id)` → einloggen. Sonst: existiert ein `users`-
  Eintrag mit derselben E-Mail (z.B. aus Passwort-Registrierung) → OAuth-
  Konto wird daran verknüpft (neue `oauth_accounts`-Zeile). Sonst → neuer
  `users`-Eintrag, `password_hash = null`, `email_verified = true` (E-Mail
  gilt als vom Provider bestätigt).
- Zugangsdaten pro Provider (Client-ID/-Secret) und die Redirect-Basis-URL
  kommen aus ENV-Variablen (`GOOGLE_CLIENT_ID`/`_SECRET`,
  `FACEBOOK_CLIENT_ID`/`_SECRET`, `DISCORD_CLIENT_ID`/`_SECRET`,
  `OAUTH_REDIRECT_BASE_URL`).
- Registrierungsformular/Login-Seite bekommt zusätzlich drei Buttons
  ("Mit Google anmelden" etc.), die auf `/auth/oauth/:provider/start`
  verlinken – kein separates OAuth-UI-Modul nötig.

**Sessions** (gemeinsam für beide Auth-Wege)
- Beim Login wird ein zufälliges Token (`crypto.randomBytes`)
  erzeugt, in `sessions` gespeichert und als `HttpOnly`+`Secure`+`SameSite=Lax`
  Cookie gesetzt. Jeder Request prüft das Cookie gegen die Tabelle.

## Rollen & Endpunkte (Übersicht)

| Rolle            | Darf |
|-------------------|------|
| `participant`      | eigenes Konto lesen/ändern, eigene Charaktere anlegen/ändern, sich zu Events an-/abmelden |
| `checkin_helper`    | pro Event: Teilnehmerliste sehen (Name, Charaktere, Status), Check-In/Check-Out durchführen. Kein Zugriff auf verschlüsselte Felder, keine Event-/Formular-Verwaltung |
| `admin`             | alles: Events anlegen/Formular definieren, alle Konten/Charaktere einsehen (inkl. entschlüsselter Felder), Rollen vergeben, Check-In/Out |

Die API prüft die Rolle serverseitig bei jedem Request (kein
Security-by-obscurity im Frontend).

## Logging & Debugging

- Zentrales `backend/logger.js`: strukturierte JSON-Logs auf `stdout`
  (`{ ts, level, msg, ...context }`), Level `debug|info|warn|error` über
  ENV-Variable `LOG_LEVEL` steuerbar (Default `info`, `debug` lokal). Kein
  Logging-Framework (pino/winston) – bei diesem Umfang reicht ein
  ~20-Zeilen-Wrapper um `console.log`/`console.error`.
- Jeder Request bekommt eine kurze Request-ID (`crypto.randomUUID()`),
  die durch alle Logzeilen dieses Requests durchgereicht und als
  `X-Request-Id`-Response-Header zurückgegeben wird – Nutzer-Fehlermeldung
  ("Fehler, Request-ID xyz") lässt sich damit direkt in den Server-Logs
  wiederfinden.
- Jeder Request wird mit Methode, Pfad, Status, Dauer (ms) und User-ID
  (falls eingeloggt) geloggt; unbehandelte Fehler mit Stacktrace auf
  `error`-Level, dem Client aber nur eine generische Meldung + Request-ID
  (keine Stacktraces/Interna nach außen).
- Lokale Entwicklung: `docker compose up` mit `LOG_LEVEL=debug` und
  gemountetem Source-Verzeichnis (kein Rebuild pro Änderung nötig, Node
  läuft mit `--watch`).

## Testing

Kein Test-Framework-Dependency – Node's eingebautes `node:test` reicht für
den überschaubaren Umfang. Läuft mit `node --test --experimental-test-coverage`
(Coverage-Reporting ebenfalls in Node eingebaut, kein `c8`/`nyc` nötig).

**Unit-Tests** (schnell, keine DB):
- `fieldCrypto`: encrypt/decrypt round-trip, unterschiedliche IVs pro Aufruf,
  Manipulation am Ciphertext → Entschlüsselung schlägt erkennbar fehl
  (GCM Auth-Tag)
- Passwort-Hashing: hash/verify round-trip, falsches Passwort schlägt fehl
- Charakterformular-Validierung: Pflichtfelder fehlen → Fehler, unbekannte
  Felder → Fehler, gültige Daten → ok
- Check-In/Check-Out-Statusmaschine: `registered → checked_in → checked_out`,
  ungültige Übergänge (z.B. Check-Out ohne Check-In) → Fehler
- OAuth-Callback-Handler: mit gemocktem `fetch` (Token-/Userinfo-Response) –
  neuer Nutzer, Verknüpfung mit bestehender E-Mail, bekannter
  `oauth_accounts`-Eintrag, falscher/fehlender `state` → Fehler

**Integrationstests** (gegen echte Test-Postgres, kein DB-Mocking):
- Jeder Test läuft in einer Transaktion, die am Ende zurückgerollt wird
  (`BEGIN` in `before each`, `ROLLBACK` in `after each`) – schnell, isoliert,
  keine Reihenfolge-Abhängigkeit zwischen Tests.
- Rollen-/Berechtigungsgrenzen: `checkin_helper` bekommt keine verschlüsselten
  Felder ausgeliefert, `participant` kann keine fremden Charaktere/Events
  ändern, unauthentifizierte Requests auf geschützte Endpunkte → 401/403
- End-to-End-Flows über die HTTP-Schicht: Registrierung → Verifizierung →
  Login → Charakter anlegen → zu Event anmelden → Check-In → Check-Out
- Session-Ablauf: abgelaufenes/ungültiges Session-Token wird abgelehnt

**CI-Tauglichkeit**: Test-DB via Docker-Compose-Service (`db-test`), damit
`node --test` lokal wie in CI ohne manuelles Setup gegen eine echte Postgres
läuft.

## Offene Punkte für die Umsetzung (kein Blocker für die Spec)

- Konkretes SMTP-Setup (Provider/Zugangsdaten) folgt beim Deployment, nicht
  Teil der Implementierung selbst (Konfiguration über ENV-Variablen).
- OAuth-App-Registrierung bei Google/Facebook/Discord (Client-ID/-Secret,
  erlaubte Redirect-URIs) muss der Nutzer selbst in den jeweiligen
  Developer-Consoles anlegen – nicht Teil der Implementierung.
- Reverse Proxy / TLS-Terminierung liegt außerhalb dieses Projekts.
