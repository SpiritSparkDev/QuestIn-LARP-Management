# Docker Compose

Three compose files exist — always pick explicitly with `-f`, never rely on Docker's default file resolution:

- `docker-compose.yml` — **production** (used on the Plesk server, no bind mounts, `npm start`, no exposed DB port). Do not use this for local development.
- `docker-compose.dev.yml` — **local development** (bind mounts for live-reload, `nodemon`, exposed Postgres port). Use this one when developing/testing locally:

```bash
docker compose -f docker-compose.dev.yml up
```

- `docker-compose.offline.yml` — **offline Con instance** (Postgres + app with `APP_MODE=offline` + Caddy TLS proxy on `con.local`). Only for on-site check-in/tavern; see `docs/betrieb-offline.md`. Never start it with plain `docker compose up`.

The production compose file also runs a `backup` service (nightly `pg_dump` plus
uploads archive, see `docs/betrieb-backup.md`). The app's `ENCRYPTION_KEY` is not
part of the backup; it must be stored separately.

`docker-compose.yml` is the default filename on purpose, so Plesk's Docker UI (which has no way to pass `-f`) picks up the production config automatically.

# Intentional DOM hooks — do not "clean up"

`frontend/js/formFields.js`'s `renderAccountFieldInput` wraps each OT field in
`<div class="${key}-container">`. These wrapper divs carry no CSS today and
look like unnecessary markup — they are not. The user added them by hand as
per-field hooks for upcoming UI work (targeted styling/JS per account field).
Leave them in place: do not remove, "simplify," or collapse them back to a
bare label+input when touching this function, running a cleanup/audit pass,
or refactoring `formFields.js`, even if nothing currently reads that class.

# Versionsnummer pflegen

Die App-Version steht an zwei Stellen und muss synchron bleiben:
`frontend/js/version.js` (`APP_VERSION`, wird unten links in der Sidebar
angezeigt) und `package.json` / `package-lock.json` (`"version"`, die beiden
Root-Einträge). Sie wird nicht zur Laufzeit aus Git gelesen, weil `.git` per
`.dockerignore` nicht im Image landet.

Schema (Conventional Commits, `0.x` bis zu einem bewussten 1.0-Release):
jeder Kalendertag mit Commits zählt als ein Release.
- Tag mit mindestens einem `feat:`-Commit → MINOR +1, PATCH auf 0
- Tag nur mit `fix:`-Commits → PATCH +1
- Tag nur mit `docs:`/`test:`/`refactor:`/`chore:`/`style:` → keine Änderung
- Breaking Change (`feat!:` / `BREAKING CHANGE`) → vorher mit dem User klären

Wenn du einen `feat:`- oder `fix:`-Commit erstellst, prüfe, ob für den
heutigen Tag schon ein Bump erfolgt ist (`git log --since=midnight`). Wenn
nicht, erhöhe die Version nach obigem Schema und nimm die geänderten
Versionsdateien in denselben Commit auf. Pro Tag höchstens ein MINOR-Bump;
ein späterer `feat:` am selben Tag nach einem PATCH-Bump wandelt diesen in
einen MINOR-Bump um.

# Migrationen

Neue Migration = nächste freie dreistellige Nummer in `db/migrations/`
(`NNN_snake_case.sql`), nie ein bestehendes Präfix doppelt vergeben —
`tests/unit/migrationFiles.test.js` schlägt sonst fehl. Bestehende Dateien
werden nie nachträglich geändert. Server-Vergleich: `docs/betrieb-migrationen.md`.
