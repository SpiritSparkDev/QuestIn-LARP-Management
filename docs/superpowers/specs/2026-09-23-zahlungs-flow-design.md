# Zahlungs-Flow (Ticket-Gate + Stripe + manuelle Überweisung)

## Kontext

Teilnehmer sollen ihre Teilnahmegebühr direkt im Dashboard bezahlen können.
Bisher gibt es keinerlei Zahlungs-Tracking: `registrations` kennt nur den
Lebenszyklus-Status (`pending`/`confirmed`/…), keinen Betrag und keinen
Zahlungsstatus. Das Event-Ticket (PNG/PDF-Download im Dashboard, siehe
`frontend/account.html`) ist aktuell unabhängig vom Bezahlstatus nutzbar.

Zahlungen sollen auf vier Wegen möglich sein: PayPal, Kreditkarte, klassische
Überweisung, Überweisung per Girocode (EPC-QR-Code fürs Banking-App-Scannen).
PayPal und Kreditkarte laufen über ein Payment-Gateway mit automatischer
Bestätigung; Überweisung und Girocode bleiben manuell (Admin gleicht
Kontoauszug/PayPal-Postfach ab und markiert die Registrierung von Hand als
bezahlt).

## Entscheidungen aus dem Brainstorming

- **Ein Gateway für PayPal + Kreditkarte**: Stripe Checkout Sessions, gefiltert
  auf die passende `payment_method_types`, statt zwei getrennte Integrationen
  (natives PayPal-SDK + separater Kartenanbieter). Halbiert Integrations- und
  Wartungsaufwand (ein Webhook, ein Dashboard).
- **Betrag pro Registrierung individuell**, nicht pro Event oder Rolle. Admin
  trägt den fälligen Betrag manuell pro Anmeldung ein.
- **Kein Betrag gesetzt = kein Zahlungs-Gate.** Bestehende Registrierungen sind
  nach dem Rollout automatisch unbetroffen; das Ticket bleibt nutzbar, bis der
  Admin gezielt einen Betrag hinterlegt.
- **Überweisung/Girocode bleiben manuell bestätigt.** Kein Open-Banking/PSD2-
  Kontoabgleich — das wäre ein eigener Bank-API-Vertrag und in den meisten
  Kontomodellen gar nicht ohne Weiteres möglich.

## Datenmodell

```sql
ALTER TABLE registrations ADD COLUMN amount_due_cents integer;
ALTER TABLE registrations ADD COLUMN paid_at timestamptz;

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('stripe_card', 'stripe_paypal', 'bank_transfer')),
  amount_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded', 'failed')),
  provider_reference text,
  confirmed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, event_id) REFERENCES registrations(user_id, event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX payments_provider_reference_idx ON payments (provider_reference) WHERE provider_reference IS NOT NULL;

ALTER TABLE app_settings ADD COLUMN stripe_secret_key_enc bytea;
ALTER TABLE app_settings ADD COLUMN stripe_publishable_key text;
ALTER TABLE app_settings ADD COLUMN stripe_webhook_secret_enc bytea;
ALTER TABLE app_settings ADD COLUMN bank_iban text;
ALTER TABLE app_settings ADD COLUMN bank_bic text;
ALTER TABLE app_settings ADD COLUMN bank_account_holder text;
```

`provider_reference` = Stripe Checkout Session ID für `stripe_*`-Methoden
(macht den Webhook idempotent via `ON CONFLICT DO NOTHING`); `NULL` für
`bank_transfer`.

`amount_due_cents IS NOT NULL AND paid_at IS NULL` ⇒ Ticket gesperrt.
`amount_due_cents IS NULL` ⇒ kein Gate, unabhängig von `paid_at`.

## Backend

Neues Modul `backend/payments/` (repository.js + routes.js), gleiches Muster
wie `backend/appSettings`.

- `POST /events/:eventId/registrations/:userId/checkout-session`
  Body: `{ method: 'card' | 'paypal' }`. Nur der Teilnehmer selbst (userId ==
  Caller) darf das für seine eigene Registrierung auslösen. Validiert, dass
  `amount_due_cents` gesetzt und `paid_at` noch leer ist. Erstellt eine Stripe
  Checkout Session:
  - `payment_method_types: ['card']` bzw. `['paypal']`
  - `amount = amount_due_cents`, `currency: 'eur'`
  - `client_reference_id = "${eventId}:${userId}"`
  - success/cancel URL zurück auf `/account.html#veranstaltung`
  Antwort: `{ url }`, Frontend leitet per `window.location.href` weiter.

- `POST /webhooks/stripe` — kein Auth-Middleware, dafür Stripe-Signatur-
  Prüfung über `stripe_webhook_secret_enc`. Bei `checkout.session.completed`:
  `client_reference_id` in `eventId`/`userId` zerlegen, `payments`-Zeile
  einfügen (`ON CONFLICT (provider_reference) DO NOTHING` für Retry-
  Sicherheit) und `registrations.paid_at = now()` setzen, falls noch leer.
  Antwortet immer mit 200 (auch wenn die Registrierung inzwischen gelöscht
  wurde), damit Stripe nicht in eine Retry-Schleife läuft; Fehler werden
  geloggt, nicht als 4xx/5xx beantwortet.

- `PATCH /events/:eventId/registrations/:userId/payment` (Admin/Moderator,
  gleiche Berechtigung wie bestehende Admin-Registrierungs-Routen) — Body
  `{ amountDueCents }` setzt/ändert den fälligen Betrag, oder
  `{ markPaid: true }` / `{ markPaid: false }` markiert manuell bezahlt/offen
  (schreibt bzw. löscht den zugehörigen `bank_transfer`-`payments`-Eintrag,
  setzt/löscht `paid_at`).

- `backend/payments/reference.js`: reine Funktion `buildPaymentReference
  (eventId, userId)`, erzeugt einen kurzen, stabilen String fürs
  Verwendungszweck-Feld (z.B. Kurzform von event+user, ähnlich dem
  bestehenden QR-Scan-Code-Format aus `frontend/js/qrCode.js`).

Stripe-Zugriff kapselt sich in `backend/payments/stripeClient.js`
(`new Stripe(secretKey)`), Key wird bei Bedarf aus `app_settings` entschlüsselt
(gleiches Muster wie `smtpSettings/repository.js` → `getSmtpSettingsForSending`).

Einzige neue npm-Abhängigkeit: `stripe` (offizielles Node-SDK) — Webhook-
Signaturprüfung ist ein Sicherheitspfad, der nicht selbst nachgebaut wird.

## Admin-Einstellungen

Erweiterung von `frontend/admin/settings.html` (dort liegen SMTP-Settings
bereits nach demselben Muster) um einen Abschnitt "Zahlungen": Stripe Secret
Key / Publishable Key / Webhook Secret, sowie IBAN/BIC/Kontoinhaber fürs
Überweisungs-Info-Fenster. Folgt exakt dem bestehenden SMTP-Settings-Formular
(Feld bleibt leer = unverändert lassen, wie `password_enc` dort schon
funktioniert).

## Admin: Betrag & manuelle Bestätigung

Erweiterung der Teilnehmerliste in `frontend/admin/events.html` (oder
`checkin.html`, je nachdem wo die bestehende Teilnehmerliste pro Event
gerendert wird) um pro Registrierung:
- Eingabefeld für `amount_due_cents` (als Euro-Betrag, Backend rechnet in
  Cent um).
- Anzeige des Zahlungsstatus: "Kein Betrag hinterlegt" / "Offen (X €)" /
  "Bezahlt am DD.MM. via PayPal/Karte/Überweisung".
- Button "Als bezahlt markieren" (nur bei offenem Betrag, für den manuellen
  Überweisungs-Pfad) bzw. "Zahlung zurücksetzen".

## Frontend: Dashboard (`frontend/account.html`)

Ticket-Panel (`#ticket-panel`): wenn die aktive Registrierung
`amountDueCents` gesetzt und `paidAt` leer hat, werden `#ticket-download-png`
und `#ticket-download-pdf` disabled und ein Hinweistext "Zahlung offen"
zusammen mit einem neuen Button "Jetzt zahlen" angezeigt.

"Jetzt zahlen" öffnet ein `<dialog id="payment-dialog">` mit vier Optionen:
- **Per PayPal** / **Per Kreditkarte**: `POST .../checkout-session` mit dem
  jeweiligen `method`, dann `window.location.href = url`.
- **Überweisungsinformationen anzeigen**: klappt einen Textblock auf
  (IBAN/BIC/Kontoinhaber/Betrag/Referenz aus `/app-settings` bzw. den
  Registrierungsdaten).
- **Girocode**: klappt einen Canvas auf, der client-seitig einen EPC069-12-QR-
  Payload rendert — mit der bereits auf der Seite geladenen
  `qrcode-generator`-Lib, exakt demselben Rendering-Code wie der bestehende
  Ticket-QR (`loadQrCode` in `account.html`), nur mit anderem Payload-String.

Nach Rückkehr vom Stripe-Redirect (Erfolg oder Abbruch) lädt die Seite die
Registrierungen neu (`loadRegistrations()` läuft ohnehin beim Seitenaufbau),
wodurch ein frisch gesetztes `paidAt` sofort das Gate aufhebt.

## Fehlerbehandlung

- Checkout-Session-Erstellung schlägt fehl (z.B. Stripe nicht konfiguriert) →
  Toast über bestehendes `notify()`.
- Webhook mit ungültiger Signatur → 400, kein DB-Zugriff.
- Webhook für eine inzwischen gelöschte Registrierung → geloggt, trotzdem 200
  (Stripe soll nicht retryen).
- Admin versucht, einen Betrag auf eine bereits bezahlte Registrierung zu
  ändern → erlaubt (z.B. Korrektur), ändert aber nicht automatisch `paid_at`.

## Tests

- Integrationstest für `backend/payments/repository.js`: manuelles
  Markieren/Zurücksetzen, Webhook-Idempotenz (zweimal dasselbe
  `checkout.session.completed`-Event → nur eine `payments`-Zeile, `paid_at`
  bleibt stabil).
- Kein Live-Stripe-Aufruf in Tests — der Stripe-Client wird injiziert/gefaked
  (Projekt nutzt `node:test`, kein Mocking-Framework vorhanden → Fakes von
  Hand, konsistent mit dem Rest der Test-Suite).
- Abschließender Task des Implementierungsplans: vollständiger Testlauf
  (`npm test`), nicht nur die neuen Payment-Tests.
