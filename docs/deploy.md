# Deploy und Deploy-Webhook

Stand: 2026-10-08 (Plan P4). Produktion läuft mit `docker-compose.yml` (Plesk-Docker-UI bzw. ein Stack-Manager, siehe unten). Der Code im Repo ist fertig; **welches System den Hook ausliefert, muss am Server geklärt werden** (offene Frage im Plan).

## Ablauf
1. Push auf `main` → GitHub Actions: `test`, `lint-light`, `docker-build` müssen grün sein.
2. Job `deploy` ruft `scripts/deploy-hook.sh` auf: `POST` auf den Webhook (Secret `DEPLOY_HOOK_URL`). Jede Antwort außer 2xx lässt den Job **rot** werden, mit dem Status im Log (die URL wird nie ausgegeben).
3. Ist die Repository-Variable `DEPLOY_HEALTH_URL` gesetzt (z. B. `https://questin.example.org/health`), wartet der Job bis zu 5 Minuten, bis `/health` mit der erwarteten `APP_VERSION` antwortet. Das beweist, dass der neue Stand wirklich läuft. Grenze: Die Version ändert sich nur an Tagen mit `feat:`/`fix:`, bei mehreren Deploys am selben Tag prüft das nur „läuft und antwortet".
4. Ohne Secret überspringt der Job den Aufruf mit Hinweis (grün). Es ist also nichts aktiv, bis ihr es einrichtet.

Einrichten: GitHub → Repo → Settings → Secrets and variables → Actions → Secret `DEPLOY_HOOK_URL`, optional Variable `DEPLOY_HEALTH_URL`.

## Der 404 auf `/api/stacks/webhooks/…` (offene Punkte, Nr. 17)
Dieser Pfad ist das Muster eines **Portainer-Stack-Webhooks**, nicht von Plesk. Ein Portainer-Webhook erwartet einen leeren **POST** und antwortet 204. Eingrenzen, ohne etwas zu ändern:

1. **Wo steht der Hook?** GitHub → Settings → Webhooks → „Recent Deliveries" (Request und Response ansehen) und/oder in der Registry.
2. **Läuft dort wirklich Portainer?** Stack öffnen, Webhook-URL neu anzeigen lassen und mit der hinterlegten vergleichen (ID, Host, Port, `https`).
3. **Gegenprobe von Hand** (die URL nicht in geteilte Logs/Chats kopieren):
   ```
   curl -i -X POST '<webhook-url>'
   ```
   | Antwort | Bedeutung |
   |---|---|
   | 204/200 | Hook funktioniert. Das „ping"-Event von GitHub passt nur nicht dazu (GitHub schickt ein JSON-`ping`; der Job hier schickt einen leeren POST). |
   | 404 | Webhook-ID stimmt nicht mehr (Stack neu angelegt, Webhook neu erzeugt) oder ein Reverse Proxy leitet `/api/` nicht an Portainer weiter. |
   | 401/403 | Proxy-/Zugriffsregel blockiert. |
   | Verbindungs-/TLS-Fehler | Host, Port oder Zertifikat. |
4. Behebung je nach Ergebnis: neue URL ins Secret `DEPLOY_HOOK_URL` eintragen (alte löschen); Proxy-Route freigeben; oder, falls es gar kein Portainer gibt, den Hook streichen (Variante B).

## Varianten
- **A – Hook per Workflow (vorbereitet):** Funktioniert direkt, wenn der Stack-Manager den Code selbst aus Git baut (`docker-compose.yml` nutzt `build: .`, Portainer-Git-Stack mit Webhook zieht und baut neu). Würde stattdessen ein Registry-Image genutzt, bräuchte die Compose-Datei ein `image:` und der Workflow einen Push-Schritt. Das ist nicht umgesetzt.
- **B – manuell/Plesk:** Auf dem Server `git pull && docker compose up -d --build`, danach `/health` und die Versionsanzeige unten links prüfen. Den Job `deploy` dann einfach ohne Secret lassen.

## Wartungsseite statt „502 Bad Gateway“ während des Neustarts
Solange der Container neu baut oder startet, antwortet der Plesk-nginx davor mit 502/504. Die App kann das nicht selbst abfangen, weil sie in diesem Moment nicht läuft. Deshalb liefert nginx eine eigene, statische Seite aus: [`deploy/nginx/deploy-wartung.html`](../deploy/nginx/deploy-wartung.html). Sie ist komplett eigenständig (kein CSS/JS/Font aus der App), erklärt den Neustart, fragt alle 5 Sekunden `/health` ab und lädt die ursprünglich aufgerufene Seite automatisch neu, sobald die App wieder antwortet.

Einmalig einrichten:
1. `deploy-wartung.html` auf den Server kopieren, außerhalb des Containers, z. B. nach `/var/www/vhosts/<domain>/deploy-wartung.html`. Der nginx-Prozess muss sie lesen können.
2. Plesk → Websites & Domains → Domain → **Apache & nginx Settings** → **Additional nginx directives**: den Inhalt von [`deploy/nginx/deploy-wartung.conf`](../deploy/nginx/deploy-wartung.conf) einfügen und den Pfad in `alias` anpassen. Speichern (Plesk prüft die Konfiguration vor dem Übernehmen).
3. Test: Container kurz stoppen (`docker compose stop app`), die Domain aufrufen → Wartungsseite mit Status 503. Container wieder starten → die Seite lädt sich innerhalb weniger Sekunden selbst neu.

Was sie **nicht** ersetzt: die eigenen Fehlerseiten der App (404, 500) und die Wartungsmodus-Seite aus den Einstellungen (`/503.html`). Die kommen von der App selbst und laufen unverändert durch, weil `proxy_intercept_errors` nicht gesetzt ist. API-Aufrufe, die während des Neustarts scheitern, zeigen im Frontend die Meldung „Der Server wird gerade neu gestartet (Update) …“ (`frontend/js/api.js`).

Ändert sich `deploy-wartung.html` im Repo, muss sie von Hand neu auf den Server kopiert werden. Sie ist nicht Teil des Images.

## Nach jedem Deploy
- `GET /health` → `{"status":"ok","version":"x.y.z"}`
- Version unten links in der Sidebar
- `docker compose logs backup` zeigt, dass der Backup-Dienst läuft (siehe `docs/betrieb-backup.md`)
