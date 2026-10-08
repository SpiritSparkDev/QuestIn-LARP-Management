# Docker Compose

Three compose files exist — always pick explicitly with `-f`, never rely on Docker's default file resolution:

- `docker-compose.yml` — **production** (used on the Plesk server, no bind mounts, `npm start`, no exposed DB port). Do not use this for local development.
- `docker-compose.dev.yml` — **local development** (bind mounts for live-reload, `nodemon`, exposed Postgres port). Use this one when developing/testing locally:

```bash
docker compose -f docker-compose.dev.yml up
```

- `docker-compose.offline.yml` — **offline Con instance** (Postgres + app with `APP_MODE=offline` + Caddy TLS proxy on `con.local`). Only for on-site check-in/tavern; see `docs/betrieb-offline.md`. Never start it with plain `docker compose up`.

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
jeder `feat:`/`fix:`-Commit erhöht die Version, nicht erst der erste des Tages.
- `feat:`-Commit → MINOR +1, PATCH auf 0
- `fix:`-Commit → PATCH +1
- `docs:`/`test:`/`refactor:`/`chore:`/`style:` → keine Änderung
- Breaking Change (`feat!:` / `BREAKING CHANGE`) → vorher mit dem User klären

Beim Erstellen eines `feat:`- oder `fix:`-Commits die Version nach obigem
Schema erhöhen und die geänderten Versionsdateien in denselben Commit
aufnehmen.
