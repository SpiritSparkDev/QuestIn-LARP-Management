# P6 CI mit GitHub Actions — Plan

**Bezug:** Empfehlung 6. Es gibt keinen `.github`-Ordner; `npm test` läuft nur lokal.

## Bestand (aus dem Repo)
- `npm test` = `node --test --test-concurrency=1 --experimental-test-coverage` (Node ≥ 20, ES Modules).
- Tests (`tests/unit`, `tests/integration`) brauchen Postgres: `TEST_DATABASE_URL` (Default `postgres://app:app@localhost:5433/pakyrion_test`) und `ENCRYPTION_KEY` (Default in den Tests `'a'×64`). Jede Testdatei ruft `runMigrations()`.
- Lokal: Dienst `db-test` in `docker-compose.dev.yml` (tmpfs, Port 5433).
- Abhängigkeiten: `package-lock.json` vorhanden → `npm ci`.

## Schritt 1 — Workflow `.github/workflows/ci.yml`
Trigger: `push` (alle Branches) und `pull_request`; `concurrency` pro Ref mit `cancel-in-progress`.

Jobs:
1. **test**
   - `runs-on: ubuntu-latest`, Service-Container `postgres:16-alpine` (Env `POSTGRES_DB=pakyrion_test`, `POSTGRES_USER=app`, `POSTGRES_PASSWORD=app`, `--health-cmd pg_isready`, Port `5433:5432` damit der Test-Default passt, oder `TEST_DATABASE_URL` setzen — letzteres bevorzugt, kein Port-Hack).
   - `actions/checkout`, `actions/setup-node` mit `node-version: 20` und `cache: npm`.
   - `npm ci`, dann `npm test` mit `TEST_DATABASE_URL` und `ENCRYPTION_KEY` als Workflow-Env (Testwert, kein Secret).
   - Timeout 15 min. Coverage-Ausgabe im Job-Log; keine Schwelle am Anfang (erst Ist-Wert messen, später Mindestwert beschließen).
2. **lint-light** (parallel, billig)
   - `node --check` über alle `backend/**/*.js`, `db/**/*.js`, `frontend/js/**/*.js` (Syntaxfehler früh).
   - `shellcheck ops/*.sh`, sobald P5 liegt.
   - Versionskonsistenz-Check (Skript `scripts/check-version.mjs`): `frontend/js/version.js` `APP_VERSION` == `package.json` `version` == beide Root-Einträge in `package-lock.json` (CLAUDE.md verlangt Synchronität; Fehlerquelle bei vergessenem Bump).
   - Migrationsdatei-Test aus P3 läuft ohnehin in `test`.
3. **docker-build** (nur auf `main`/Pull Request, optional)
   - `docker build .` als Beleg, dass das Prod-Image baut (`npm ci --omit=dev`), ohne Push.
4. **deploy** (später, gehört zu P4 Variante A): `needs: [test, docker-build]`, nur `main`, ruft Webhook auf.

## Schritt 2 — Repo-Einstellungen (manuell, vom Repo-Admin)
- Branch-Protection auf `main`: Status-Check `test` erforderlich, Pull Request vor Merge.
- Dependabot (`.github/dependabot.yml`): `npm` wöchentlich, `github-actions` monatlich; Sicherheitsupdates für `stripe`, `pg`, `nodemailer`, `pdf-lib`, `handlebars`, `@aws-sdk/*` zuerst anschauen.
- Optional `npm audit --omit=dev --audit-level=high` als nicht blockierender Job.

## Schritt 3 — Flaky-Tests vermeiden
- `--test-concurrency=1` bleibt (gemeinsame DB). Bekannte Reihenfolge-Abhängigkeit (Commit „conPayer reminder test … broke the waiver test in full runs") deutet auf geteilten `app_settings`-Zustand hin: im ersten CI-Lauf sehen, ob Läufe reproduzierbar grün sind; mehrfach hintereinander laufen lassen (3×) vor dem Verlass auf den Check.
- Keine Tests deaktivieren, um grün zu werden; Fehler an der Wurzel beheben.

## Schritt 4 — Optional: Browser-Smoke (nach P2)
Playwright ist lokal vorinstalliert, in CI per `npx playwright install --with-deps chromium` nur, wenn der Smoke-Test existiert. Prüft: Login-Seite lädt, `/health` ok, Mobile-Overflow der drei Admin-Seiten bei 390 px. Erst nach P2, weil sonst rot.

## Abnahme
- Push auf Branch → `test` läuft grün; absichtlich kaputter Test macht ihn rot; PR zeigt den Status; Versionscheck schlägt bei absichtlich verdrehter Version an.

## Aufwand
~0,5 Tag (Workflow + Versionsskript), plus 0,5 Tag für Stabilisierung, falls Tests in CI anders laufen als lokal. Versionswirkung: `chore:`/`test:` → keine Änderung.

## Reihenfolge der sechs Pläne
**P6 und P5 zuerst** (Sicherheitsnetz), dann **P3** (Migrationsvergleich mit Backup in der Hand), **P4** (nutzt grünes CI für Deploy-Job), danach **P1 + P2** zusammen mit echten Geräten kurz vor dem Con.
