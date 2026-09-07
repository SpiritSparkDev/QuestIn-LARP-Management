# Docker Compose

Two compose files exist — always pick explicitly, never rely on Docker's default file resolution:

- `docker-compose.yml` — **production** (used on the Plesk server, no bind mounts, `npm start`, no exposed DB port). Do not use this for local development.
- `docker-compose.dev.yml` — **local development** (bind mounts for live-reload, `nodemon`, exposed Postgres port). Use this one when developing/testing locally:

```bash
docker compose -f docker-compose.dev.yml up
```

`docker-compose.yml` is the default filename on purpose, so Plesk's Docker UI (which has no way to pass `-f`) picks up the production config automatically.
