# P4 Deploy-Webhook (HTTP 404) klären — Plan

**Bezug:** `docs/offene-punkte.md` Punkt 17. Im Repo steht nichts über den Hook; das Problem liegt in der Deploy-Infrastruktur, nicht im App-Code.

## Befund
- Der Pfad `/api/stacks/webhooks/<id>` ist das Muster von **Portainer** (Stack-Webhook), nicht von Plesk. `CLAUDE.md` sagt, Produktion laufe über Plesks Docker-UI. Es ist also zuerst zu klären, **welches System den Hook ausliefert**.
- Ein Portainer-Stack-Webhook erwartet einen **POST** ohne Body, antwortet 204; bei falscher/erneuerter ID (z. B. nach Stack-Neuanlage) 404. Ein GET oder ein „ping"-Test-Push von GitHub/Registry kann je nach Endpoint ebenfalls scheitern.

## Schritt 1 — Eingrenzen (ohne Änderungen)
1. Wo steht der Hook? GitHub → Repo-Settings → Webhooks (Zustellungsverlauf mit Request/Response, Spalte „Recent Deliveries") und/oder Registry (Docker Hub/GHCR) → Webhooks.
2. Zugriff auf das Zielsystem: Läuft dort wirklich Portainer? Stack-Liste öffnen, bei dem Stack **Webhook-URL neu anzeigen**; mit der in GitHub eingetragenen URL vergleichen (ID identisch? Host/Port/Schema identisch?).
3. Manuelle Gegenprobe: `curl -i -X POST '<webhook-url>'` von einem Rechner mit Netzzugang. Auswertung:
   - 204/200 → Hook ok; das „Ping"-Event von GitHub passt nur nicht (Schritt 3).
   - 404 → ID stimmt nicht (Stack neu angelegt/Webhook neu erzeugt) oder Reverse-Proxy leitet `/api/` nicht durch.
   - 401/403 → Auth/Proxy-Regel.
   - TLS-/Verbindungsfehler → Host/Zertifikat.
4. Ergebnis kurz in `docs/offene-punkte.md` Punkt 17 notieren.

## Schritt 2 — Je nach Ursache beheben
- **Stale ID:** neue URL in GitHub/Registry hinterlegen, alte löschen. URL ist ein Geheimnis → nur in GitHub-Secrets/Webhook-Konfiguration, nie ins Repo.
- **Proxy:** Route für `/api/stacks/webhooks/` zum Portainer-Port freigeben, falls Plesk/nginx davor sitzt.
- **Kein Portainer (Plesk-only):** Hook-Variante streichen und Deploy anders lösen (Schritt 3, Alternative B).

## Schritt 3 — Zuverlässiger Deploy-Ablauf festlegen
Entscheiden, welche Variante gilt (Empfehlung: A):
- **A — Image bauen und Hook per Workflow auslösen:** GitHub-Actions-Job (nach grünem CI aus P6, nur auf `main`) baut/pusht das Image in eine Registry und ruft den Hook per `curl -fsS -X POST "$DEPLOY_HOOK_URL"` auf (Secret `DEPLOY_HOOK_URL`). Der Job schlägt bei Nicht-2xx sichtbar fehl — kein stilles 404 mehr. Hinweis: `docker-compose.yml` nutzt derzeit `build: .`; für Registry-Deploy braucht es ein `image:`-Feld; das ist eine eigene Entscheidung, nicht Teil dieses Plans, falls auf dem Server gebaut wird.
- **B — Manuell/Plesk:** Deploy-Schritte in `docs/deploy.md` festhalten (git pull, `docker compose up -d --build`), Webhook entfällt.

## Schritt 4 — Nach dem Deploy prüfen
- `/health` aufrufen (siehe P5 Monitoring), Version unten links in der Sidebar (`APP_VERSION`) mit der erwarteten vergleichen; ggf. `GET /health` um `version` erweitern (klein, hilft beim Prüfen „ist der neue Stand wirklich live").

## Abnahme
- Test-Zustellung liefert 2xx; ein Push auf `main` führt nachweisbar zum Neustart des Stacks; Fehlerfall (falsche URL) lässt den Workflow rot werden.

## Aufwand
0,5 Tag Diagnose (hängt von Zugriff auf den Server ab). **Offene Frage an euch:** Läuft Produktion über Portainer oder Plesk-Docker, und wo wird der Hook ausgelöst?
