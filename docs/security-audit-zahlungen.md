# Sicherheitsaudit Zahlungs-Schnittstellen (read-only, 2026-10-09)

Geprüft: Stripe, SumUp (neu), manuelle Überweisung, Gast-Zahlungstoken, Tavernen-Aufladung, Einstellungen, Backup/Offline-Paket, Routing/Server.
Kein KRITISCH-Befund. Zeilenangaben beziehen sich auf den Stand der Arbeitskopie (inkl. uncommitteter SumUp-Änderungen).

## HOCH

### H1 Stripe-Webhook bucht ohne Betragsprüfung; Betrag kann zwischen Checkout und Zahlung sinken/steigen (Unterzahlung)
- `backend/payments/routes.js:324-332`, `backend/payments/repository.js:150-175`, `backend/registrations/repository.js:446-452`
- Szenario: Teilnehmer startet Checkout (Betrag 100 EUR, Stripe-Session mit festem `unit_amount`), ändert in einem zweiten Tab die Extras/Unterkunft (`amount_due_cents` steigt auf 150; Extras sind erst ab `paid_at` gesperrt, `registrations/repository.js:443`), zahlt die alte Session. Der Webhook setzt `paid_at`, ohne `amount_total` mit `amount_due_cents` zu vergleichen. 50 EUR fehlen, danach sind Extras gesperrt. SumUp prüft das (`routes.js:279`), Stripe nicht.
- Fix: im Stripe-Zweig `amount_total` und `currency === 'eur'` gegen `registrations.amount_due_cents` prüfen (wie SumUp), sonst Zahlung nur als `payments`-Zeile ohne `paid_at` buchen und loggen.

### H2 SumUp-Aufladung des Tavernenkontos wird als Teilnahmegebühr verbucht
- `backend/payments/routes.js:64` (SumUp-Zweig ignoriert `clientReferenceId`), `:219`, `:234`, `:273-285`
- Szenario: `POST /tavern/my-topup-session` mit `method:'sumup'` erzeugt eine Referenz `eventId:userId:rand`. Der Webhook verbucht sie als Event-Zahlung (`paid_at` gesetzt, falls Betrag >= fällig), das Tavernenkonto wird nie gutgeschrieben. Geld weg bzw. falsch gebucht, jeder angemeldete Nutzer kann das auslösen.
- Fix: `sumup` in der Tavern-Route vorerst ablehnen (400) oder Referenz `tavern:<accountId>:rand` bilden und im Webhook `topUpFromStripe` aufrufen.

### H3 Rate-Limiting hinter Reverse-Proxy (Plesk) nutzt Proxy-IP (unsicher, hängt vom Deployment ab)
- `backend/middleware/rateLimit.js:43`
- Szenario: Läuft die App hinter Plesk/nginx, ist `remoteAddress` für alle Clients dieselbe. Das IP-Limit für Login (10/15 min) und Gast-Anmeldung wird dann global verbraucht: ein Angreifer sperrt den Login für alle (DoS), und das IP-Limit schützt nicht mehr pro Angreifer. Das E-Mail-Limit (`login.js:23`) bleibt aktiv, sperrt aber ebenfalls gezielt Konten (Lockout-DoS).
- Fix: `TRUST_PROXY`-Env, dann letzten Hop aus `X-Forwarded-For` nehmen (Proxy muss den Header setzen/überschreiben); Prüfen, ob der Container direkt oder via Proxy erreicht wird.

## MITTEL

### M1 SumUp-Webhook-Secret und Gast-Zahlungstoken landen im Request-Log
- `backend/server.js:92,98,113,117` loggen `path: pathname`; Pfade `/webhooks/sumup/<secret>` und `/public/registrations/<token>[/checkout-session]` stehen im Klartext in den Container-Logs (und in Plesk/nginx-Access-Logs). Auch falsche Rateversuche werden geloggt.
- Szenario: Wer Logs lesen kann (Hosting-Support, Log-Aggregator), erhält Secret/Token. Secret-Leak ist begrenzt, weil der Webhook den Checkout per API neu liest (`routes.js:265`), der Gast-Token liefert aber Ticket/Name und Checkout-Start.
- Fix: im Logger Pfade mit `/webhooks/sumup/*` und `/public/registrations/*` auf `/webhooks/sumup/[redacted]` bzw. `/public/registrations/[redacted]` kürzen. Außerdem Secret nicht rotierbar (`paymentSettings/repository.js:62,73` COALESCE): Rotation (Endpunkt oder Löschen der Spalte) ergänzen.

### M2 Webhook-Fehler beim Verbuchen werden verschluckt (Zahlung eingegangen, aber nicht gebucht)
- `backend/payments/routes.js:287-289` (SumUp), `:333-338` (Stripe), `:321-323` (Tavern)
- Szenario: Kurzer DB-Ausfall während des Webhooks: HTTP 200, Stripe/SumUp wiederholen nicht, Teilnehmer hat gezahlt, bleibt "unbezahlt" und bekommt Mahnungen. Auch SumUp: Betrag zu niedrig wird nur geloggt (`:279-282`), Geld ist eingegangen, ohne sichtbaren Hinweis.
- Fix: nur bei `REGISTRATION_NOT_FOUND` mit 200 antworten, sonst 500 (Stripe wiederholt, Idempotenz via `provider_reference` ist vorhanden); Unterzahlungen als `payments`-Zeile oder Audit-Eintrag sichtbar machen.

### M3 Abgesagte/Wartelisten-Anmeldungen können bezahlen und werden gemahnt
- `backend/payments/routes.js:97-105` und `:169-177` (kein `status`-Filter), `backend/payments/repository.js:187-193` (Mahnliste ohne Status)
- Szenario: Abgesagte oder auf der Warteliste stehende Anmeldung startet Checkout; `paid_at` wird gesetzt, Geld muss manuell erstattet werden. Mahnmails gehen auch an Abgesagte.
- Fix: `status IN ('pending','confirmed')` in beiden Checkout-Routen und in `listUnpaidRegistrationsForEvent` ergänzen (Wartelisten bewusst erlauben oder blocken, je nach Fachlogik).

### M4 Änderung von Zahlungseinstellungen und Zahlungsstatus ohne Audit/Akteur
- `backend/paymentSettings/routes.js:12-17` (Stripe-Key/IBAN/SumUp-Key ändern, kein `logAudit`, keine Re-Authentifizierung), `backend/payments/repository.js:23,46,96` (`setAmountDue`, `setDiscount`, `markUnpaid` ohne Audit), `:228` (Erstattung mit `actorId: null`), `routes.js:383` (Akteur wird nicht übergeben)
- Szenario: Übernommenes Admin-Konto tauscht IBAN oder Stripe-Key, Zahlungen fließen um; staff mit Menü `checkin` setzt Beträge auf 0, markiert bezahlt/erstattet ohne Spur, wer es war.
- Fix: `logAudit({actorId: user.id, action:'payment_settings.changed', details:{fields:[...]}})` (ohne Werte), dasselbe für Betrag/Rabatt/unpaid/Erstattung mit `user.id`; optional Passwort-Bestätigung für Key-/IBAN-Änderung.

### M5 Keine Sicherheits-Header (Clickjacking, kein CSP, Referrer)
- `backend/server.js:67-126` setzt weder `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy` noch `X-Content-Type-Options` für statische Dateien (`staticFiles.js`, nur API-Downloads haben nosniff).
- Szenario: Admin-Einstellungen oder Zahlungsdialog in fremdem iframe (Clickjacking). `guest-payment.html:10-11` lädt `qrcode-generator@1` und `html2canvas@1` von jsDelivr ohne SRI und mit schwebender Version; die Seite enthält den Token in der URL, ein kompromittiertes Paket kann Ticket/Checkout übernehmen.
- Fix: globale Header (`frame-ancestors 'self'` bzw. `X-Frame-Options: DENY` außer Widget-Seite, `Referrer-Policy: no-referrer`, `nosniff`) in `handleRequest`; CDN-Skripte auf feste Version + `integrity` oder lokal ausliefern.

### M6 Doppelte/konkurrierende Erstattung (Stripe vor DB-Buchung)
- `backend/payments/routes.js:383-426`, `backend/payments/repository.js:212-238`
- Szenario: Zwei gleichzeitige Teil-Erstattungen: beide rufen `stripe.refunds.create` (`:416`), danach bucht nur eine (`ALREADY_REFUNDED` bei der anderen). Stripe hat mehr erstattet als gebucht. Es wird zudem nur die jüngste Zahlung erstattet, Mehrfachzahlungen (z. B. Stripe + SumUp) bleiben unsichtbar.
- Fix: Zeile zuerst per `UPDATE ... SET refunded_at=now() ... RETURNING` reservieren (in Transaktion), dann Stripe aufrufen, bei Stripe-Fehler zurückrollen; Idempotency-Key `payment.id` an `refunds.create` mitgeben.

## NIEDRIG

- N1 Mehrfach-Checkouts/Stripe-Customers: `POST .../checkout-session` und `/public/registrations/:token/checkout-session` haben kein Rate-Limit; `bank_transfer` legt pro Aufruf einen Stripe-Customer mit E-Mail/Name an (`routes.js:29-35`). Fix: `rateLimit` (z. B. 10/15 min) vorschalten.
- N2 Zweite Zahlung bei bereits bezahlter Anmeldung über Webhook (z. B. zwei offene Sessions): wird als weitere `payments`-Zeile gebucht, `paid_at` bleibt (`repository.js:162-172`); keine Warnung. Fix: Audit-Hinweis "Doppelzahlung".
- N3 `client_reference_id` im Stripe-Webhook wird nicht gegen bekannte Sessions geprüft (`routes.js:312-313`). Nur ausnutzbar, wenn im selben Stripe-Konto Payment-Links/Fremdprodukte mit eigener Referenz laufen (unsicher; Doppelpunkt ist in Payment-Link-Referenzen nicht erlaubt). Fix: `amount_total`/`currency` prüfen (siehe H1), dedizierten Stripe-Account nutzen.
- N4 Login: früher Rückgabe bei unbekannter E-Mail ohne Hash-Berechnung (`auth/login.js:31-33`) erlaubt Timing-Enumeration; E-Mail-Sperre (5/15 min) erlaubt Lockout fremder Konten. Fix: Dummy-Hash vergleichen.
- N5 Session-Token liegt im Klartext in `sessions.token` (`auth/sessions.js:9,14`); bei DB-Leak sofort nutzbar. Fix: SHA-256 des Tokens speichern.
- N6 CSRF-Schutz beruht allein auf `SameSite=Lax` (`auth/cookies.js:21`); `readJsonBody` prüft keinen `Content-Type`/`Origin` (`httpBody.js`). Lax blockiert Cross-Site-POST, Schutz fehlt nur gegen Same-Site-Subdomains. Fix: bei Mutationen `Origin`-Header gegen `baseUrl` prüfen.
- N7 `Secure`-Flag nur bei `NODE_ENV=production` (`cookies.js:17`); `APP_BASE_URL` mit `http://` würde das SumUp-Webhook-Secret im Klartext an SumUp senden (`routes.js:239`). Fix: Start-Warnung bei `http` in Produktion.
- N8 Keine Eingabevalidierung der Zahlungseinstellungen (Typ, IBAN-Format, Merchant-Code) in `paymentSettings/routes.js:15`; nur Admin, Fehlbedienung statt Angriff. Beträge: `amountDueCents` Integer >= 0 geprüft, aber ohne Obergrenze (`routes.js:350`, `:357`).
- N9 Stripe-Erstattungen im Stripe-Dashboard und Streitfälle werden nicht zurückgespiegelt (`charge.refunded`/`dispute` nicht behandelt, `routes.js:309-340`). Fachlich, kein Zugriffsproblem.
- N10 Zahlungsroute `PATCH .../payment` und Refund sind während einer Offline-Delegation nicht vom Write-Guard gesperrt (`instanceAuthority/guard.js:3-13` kennt nur Check-in/Tavern). Auswirkung beim Handback unsicher.
- N11 SumUp meldet `PAID`, aber Webhook kommt nie an (kein Polling/Abgleich); Teilnehmer bleibt unbezahlt. Fix: Ergebnis-Seite ruft den Checkout-Status serverseitig ab oder Admin-Button "SumUp abgleichen".
- N12 `payment-reminders` ohne Rate-Limit/Idempotenz (`routes.js:431`): Personal mit Menü `checkin` kann beliebig oft alle Unbezahlten anschreiben.

## OK (geprüft, für sicher gehalten)

- Autorisierung Einstellungen: `GET/PUT /admin/settings/payments` hinter `requireAuth(requireAdminGroup)` (`paymentSettings/routes.js:7,12`); "Als ... betrachten" betrifft nur echte Admins (`authenticate.js:59`). `GET /payment-settings` liefert nur IBAN/BIC/Inhaber/QR-Flag/`sumupEnabled` (`repository.js:28-32`), nie Schlüssel; für alle Angemeldeten bewusst.
- Checkout-Berechtigung (IDOR): `params.userId !== user.id && !canRegisterFor(...)` (`routes.js:90`), `canRegisterFor` = verwaltete Person oder Gruppen-Vorgesetzter (`managedPersons/repository.js:40`); `payments_open`, Con-Zahler, kein Betrag, bereits bezahlt werden geprüft (`routes.js:102-105`). Betrag kommt aus der DB, nie vom Client; Währung fix EUR; Tavern-Betrag Integer 500-20000 (`routes.js:206`).
- Zahlungsstatus setzen/erstatten nur mit `requireAuth(requireMenu('checkin'))` (`routes.js:345,383,431`); `markPaid` doppelsicher via `FOR UPDATE` + `paid_at`-Prüfung und Audit mit Akteur (`repository.js:63-93`); Erstattung <= bezahlter Betrag und positive Ganzzahl (`routes.js:385,398`).
- Stripe-Webhook: Signaturprüfung mit `constructEvent` auf Raw-Body (`routes.js:303`), 300 s Toleranz (Replay), Idempotenz via Unique-Index `payments_provider_reference_idx` (`041_zahlungen.sql:15`) und `ON CONFLICT DO NOTHING`; Verzögerte Methoden nur bei `payment_status==='paid'` bzw. `async_payment_succeeded` (`:310-311`); Tavern-Idempotenz per Account-Lock + `provider_reference` (`tavern/repository.js:234-241`).
- SumUp-Webhook: Secret mit `crypto.timingSafeEqual` (`routes.js:247-251`), 192 Bit Entropie (`paymentSettings/repository.js:62`), gleiche Antwort für "nicht konfiguriert" und "falsches Secret" (`:260`); Body wird nie vertraut, Checkout wird per API neu gelesen, geprüft auf `PAID`, `merchant_code`, `EUR`, Betrag >= fällig, UUID-Referenz (`:262-285`); Idempotenz via `sumup:<id>`. Secret wird nie an den Client geliefert (nicht in GET-Settings, nicht im UI, nur serverseitig als `return_url` an SumUp).
- SumUp-Client: Checkout-ID per Regex `^[A-Za-z0-9-]{1,64}$` (kein SSRF/Pfad-Injection), feste Ziel-URL, Timeout 15 s, Fehlermeldungen ohne Antwort-Body und ohne Key (`sumupClient.js:5,22-26,50`). Offline: `getSumupConfig`/`getStripeClient` liefern `null` (`sumupClient.js:9`, `stripeClient.js:6`), Webhooks antworten 404/503, Checkout 502; Hintergrund-Jobs aus.
- Geheimnisse: Stripe-Key, Webhook-Secret, SumUp-Key und -Secret AES-256-GCM mit zufälligem IV (`crypto/fieldCrypto.js`), `ENCRYPTION_KEY` Pflicht beim Start; UI zeigt nur `has*`-Flags und Platzhalter, Felder `type=password` (`settings.html:277,284,309`). Backup (`backup/dump.js:8-9`) enthält `payment_settings` nicht, filtert Spalten `password|token`; Offline-Snapshot (`offlinePackage/snapshot.js:7,76`) enthält weder Einstellungen noch `payment_token`; Audit-Details enthalten keine Schlüssel (`payments/repository.js:178-180`).
- SQL: überall parametrisiert (`$n`), Backup/Snapshot-Tabellennamen fest bzw. per `^[a-z_]+$` geprüft; UUID-Fehler werden zu 400 (`server.js:115`).
- Body-Limit: JSON/Raw 1 MB (`httpBody.js:1`), Backup-Restore 300 MB nur Admin.
- Gast-Token: 256 Bit (`randomBytes(32)`), Ablauf serverseitig geprüft (`routes.js:130,171`), nur Ticket/Checkout, keine Passwortrechte; Guest-Konten ohne Passwort können nicht einloggen (`login.js:31`).
- Redirects: `successUrl`/`cancelUrl`/`returnUrl` aus `base_url`-Einstellung bzw. `APP_BASE_URL`, nicht aus dem `Host`-Header (`mailer.js:52-62`, `appSettings/repository.js:19`) – kein Host-Header-/Open-Redirect-Angriff.
- CORS: `Access-Control-Allow-Origin: *` nur für `/public/*` (ohne Cookies/Credentials); Webhooks und alle Cookie-Routen ohne CORS (`server.js:76-83`). Cookies `HttpOnly; SameSite=Lax; Secure` (Produktion).
- XSS: `frontend/js/help.js:50-64` und `js/help/*` rendern statische Hilfetexte (keine Nutzerdaten); `guest-payment.html` nutzt `textContent`; `account.html` maskiert dynamische Werte per `escapeHtml`; `window.location.href` bekommt nur die vom Server gelieferte Stripe-/SumUp-URL.
- Pfad-Traversal im Static-Server: `path.resolve` + Basisprüfung (`staticFiles.js:28-32`), Endungs-Whitelist.
