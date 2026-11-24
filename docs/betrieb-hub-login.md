# „Mit QuestIn anmelden“ (Hub-Login)

Die Instanz kann sich an den QuestIn-Hub (questin.de) koppeln. Das ist freiwillig;
ohne die drei Umgebungsvariablen unten läuft alles wie bisher.

## Instanz beim Hub registrieren

Am Hub (Admin-API, Bearer `HUB_ADMIN_TOKEN` des Hubs, siehe `docs/login.md` im Repo `questin-hub`):

```bash
curl -X POST https://questin.de/admin/clients \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Orga B","redirectUris":["https://orga-b.questin.de/auth/oauth/hub/callback"]}'
```

Die Redirect-URI ist immer `${OAUTH_REDIRECT_BASE_URL}/auth/oauth/hub/callback` und wird
vom Hub exakt verglichen. Die Antwort enthält `client.client_id` und **einmalig** das `clientSecret`.

## Instanz einrichten

In der `.env` der Instanz:

```
HUB_ISSUER=https://questin.de/oidc
HUB_CLIENT_ID=<client_id>
HUB_CLIENT_SECRET=<clientSecret>
```

Danach den App-Container neu starten. Die Login-Seite zeigt „Mit QuestIn anmelden“,
im Konto-Bereich erscheint die Karte „QuestIn-Konto aktivieren“.

## Verhalten

- Login über Authorization Code + PKCE (S256); `state`, `nonce` und der PKCE-Verifier liegen in
  kurzlebigen HttpOnly-Cookies. Das `id_token` wird gegen die JWKS des Hubs geprüft
  (Signatur, `iss`, `aud`, `exp`, `nonce`); die Identität ist allein dessen `sub`.
- Bekanntes `sub` → Anmeldung. Unbekanntes `sub`:
  - kein lokales Konto mit der E-Mail → neues Konto ohne Passwort (nur bei bestätigter Hub-E-Mail);
  - lokales Konto mit derselben E-Mail → **keine automatische Verknüpfung**. Bestätigungsseite
    `/hub-link.html`: lokales Passwort als Nachweis, ohne lokales Passwort ein Mail-Link.
    Die Anfrage gilt 15 Minuten und nur einmal (`hub_link_requests`).
  - lokales Konto schon mit einem anderen Hub-Konto verbunden, oder deaktiviert → Ablehnung.
- E-Mail: die bestätigte Hub-E-Mail ist führend. Weicht sie beim Login von der lokalen ab, wird sie
  übernommen, wenn kein anderes lokales Konto sie hat (`hub.email_updated`); sonst bleibt alles,
  wie es ist, und das Audit-Log bekommt `hub.email_conflict` (Admin klärt, z. B. per Zusammenführen).
- `/auth/oauth/hub/start?returnTo=/pfad` springt nach dem Login dorthin (nur relative Pfade).
- Opt-in im Konto-Bereich: überträgt E-Mail, Passwort-Hash, Namen, Spitzname und Bestätigungsstatus
  an `POST /api/v1/accounts/import` des Hubs und verknüpft das Konto. Das lokale Passwort bleibt
  vorerst erhalten. Verknüpfung und Opt-in stehen im Audit-Log (`hub.linked`, `hub.optin`).
- Im Offline-Modus ist der Hub-Login gesperrt; dort gilt nur E-Mail + Passwort.

## Stammprofil aus dem Hub (Phase 4)

- **Zuordnung (Admin → Einstellungen):** je Hub-Schlüssel (`birth_date`, `phone`, `address_street`,
  `address_zip`, `address_city`, `address_country`, `emergency_contact_name`, `emergency_contact_phone`,
  `allergies`, `medications`, `intolerances`) ein lokales Kontofeld. Nicht zugeordnete Felder werden ignoriert.
  Hat die Instanz nur ein Adressfeld, kann nur eines der Adressfelder zugeordnet werden.
- **Abruf:** Im Tab „Anmelden“ holt „Profil von QuestIn holen“ (`/auth/oauth/hub/start?profile=1`) das Profil.
  Der Hub fragt je Kategorie nach (Gesundheit nie vorausgewählt). Direkt nach dem Login holt die Instanz
  serverseitig `GET /api/v1/profile` mit dem Access-Token und speichert eine verschlüsselte Kopie je
  Kategorie (`hub_profile_snapshots`), nur für eingewilligte Kategorien. Ein Token wird nicht aufbewahrt;
  für einen neuen Abruf meldet sich die Person erneut über den Hub an.
- **Abgleich:** Abweichungen zwischen Kopie und Konto werden angezeigt, nie automatisch übernommen. Übernommen
  wird nur, was die Person auswählt (wie eine eigene Änderung im Konto, Audit `hub.fields_applied`).
- **Webhook:** Beim Hub als `webhookUrl` eintragen: `${OAUTH_REDIRECT_BASE_URL}/api/hub/webhook`. Die Signatur
  (HMAC mit `HUB_CLIENT_SECRET`, höchstens 5 Minuten alt) wird geprüft. `consent.revoked` löscht die Kopie der
  widerrufenen Kategorien, `account.deleted` löscht die ganze Kopie und löst die Verknüpfung. Das lokale Konto
  (Anmeldungen, Zahlungen, selbst übernommene Angaben) folgt weiter den Löschfristen dieser Instanz.
- **Fristen:** Die Kopie wird nach den Fristen aus `PRIVACY_CATEGORIES` gelöscht (Gesundheit 28 Tage, sonst
  180 Tage nach dem Abruf), im selben Hintergrundjob wie die Datenschutz-Löschung.
- Verwaltete Personen/Kinder sind nicht enthalten.
