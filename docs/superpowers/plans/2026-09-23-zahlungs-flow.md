# Zahlungs-Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teilnehmer können ihre individuell festgelegte Teilnahmegebühr im Dashboard per PayPal, Kreditkarte, Überweisung oder Girocode bezahlen; das Event-Ticket bleibt gesperrt, bis bezahlt ist.

**Architecture:** Ein neues `backend/payments/`-Modul kapselt Stripe Checkout Sessions (ein Gateway für PayPal + Kreditkarte) und einen Webhook, der `registrations.paid_at` setzt. Überweisung/Girocode bleiben rein informativ (EPC-QR client-seitig gerendert) und werden vom Admin manuell bestätigt. `registrations` bekommt `amount_due_cents`/`paid_at`; eine neue `payments`-Tabelle protokolliert jede Zahlung.

**Tech Stack:** Node.js (kein Framework, hand-rollierter Router), PostgreSQL (`pg`), `stripe` (neue Abhängigkeit), Vanilla-JS-Frontend (ESM-Module, kein Bundler), `node:test` für Unit-/Integrationstests.

**Spec:** [docs/superpowers/specs/2026-09-23-zahlungs-flow-design.md](../specs/2026-09-23-zahlungs-flow-design.md)

## Global Constraints

- Kein neues Dependency außer `stripe` (offizielles Node-SDK).
- Kein Live-Netzwerkaufruf gegen Stripe in Tests — Webhook-Tests nutzen `stripe.webhooks.generateTestHeaderString` für eine lokal gültige Signatur.
- `amount_due_cents IS NULL` ⇒ kein Zahlungs-Gate (Bestandsregistrierungen bleiben unangetastet).
- Bestehende Coding-Konventionen gelten: `query()`/`withTransaction()` aus `backend/db.js`, `err.code`-Pattern für Fehlerunterscheidung in Repositories, `requireAuth`/`requireMenu`/`requireAdminGroup`-Middleware-Wrapper, `notify()` für Frontend-Toasts, `escapeHtml()` für jede in HTML interpolierte Nutzereingabe.
- Deutsche UI-Texte, englische Code-/Fehler-Identifier (bestehende Konvention in diesem Repo).
- `frontend/js/formFields.js`'s `renderAccountFieldInput`-Wrapper-Divs (`${key}-container`) NICHT anfassen — siehe CLAUDE.md, sind absichtliche Hooks, in dieser Arbeit ohnehin nicht berührt.
- Letzter Task führt den VOLLSTÄNDIGEN Testlauf (`npm test`) aus, nicht nur die neuen Payment-Tests.

---

### Task 1: Migration — Zahlungs-Datenmodell

**Files:**
- Create: `db/migrations/041_zahlungen.sql`
- Test: `tests/integration/migrate.test.js` (bereits vorhanden, läuft die neue Migration automatisch mit)

**Interfaces:**
- Produces: Spalten `registrations.amount_due_cents integer`, `registrations.paid_at timestamptz`; Tabellen `payments` und `payment_settings` (Spalten siehe unten) — jeder spätere Task liest/schreibt exakt diese Namen.

- [ ] **Step 1: Migration schreiben**

```sql
ALTER TABLE registrations ADD COLUMN amount_due_cents integer;
ALTER TABLE registrations ADD COLUMN paid_at timestamptz;

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('stripe_card', 'stripe_paypal', 'bank_transfer')),
  amount_cents integer NOT NULL,
  provider_reference text,
  confirmed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, event_id) REFERENCES registrations (user_id, event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX payments_provider_reference_idx ON payments (provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE payment_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_secret_key_enc bytea,
  stripe_webhook_secret_enc bytea,
  bank_iban text,
  bank_bic text,
  bank_account_holder text
);
```

- [ ] **Step 2: Migration anwenden und verifizieren**

Run: `npm run migrate`
Expected: Log-Zeile `applied migration` mit `file: '041_zahlungen.sql'`, Exit-Code 0. Bei Bedarf vorher `docker compose -f docker-compose.dev.yml up -d` (lokale Dev-DB muss laufen).

- [ ] **Step 3: Bestehenden Migrations-Integrationstest laufen lassen**

Run: `npm test -- tests/integration/migrate.test.js`
Expected: PASS (der Test iteriert einfach über alle `.sql`-Dateien im Verzeichnis, keine Anpassung nötig).

- [ ] **Step 4: Commit**

```bash
git add db/migrations/041_zahlungen.sql
git commit -m "feat: add payment tracking schema (amount_due, paid_at, payments, payment_settings)"
```

---

### Task 2: `readRawBody` für Stripe-Webhook-Signaturprüfung

**Files:**
- Modify: `backend/httpBody.js`
- Test: `tests/unit/httpBody.test.js`

**Interfaces:**
- Produces: `readRawBody(req, maxBytes?) => Promise<Buffer | null>` — liest den Request-Body OHNE ihn zu parsen (Stripe braucht die exakten Rohbytes für die HMAC-Signatur). `null` bei Fehler oder Body über `maxBytes`.

- [ ] **Step 1: Failing Test schreiben**

An das Ende von `tests/unit/httpBody.test.js` anhängen (Datei existiert bereits mit Tests für `readJsonBody` im selben Stil — `readRawBody` importieren, `PassThrough`/Mock-`req` wie die bestehenden Tests dort verwenden):

```js
import { readRawBody } from '../../backend/httpBody.js';

test('readRawBody resolves the exact raw bytes without JSON-parsing them', async () => {
  const req = new EventEmitter();
  const promise = readRawBody(req);
  req.emit('data', Buffer.from('not valid json {{{'));
  req.emit('end');
  const result = await promise;
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.toString('utf8'), 'not valid json {{{');
});

test('readRawBody resolves null once the body exceeds maxBytes', async () => {
  const req = new EventEmitter();
  req.destroy = () => {};
  const promise = readRawBody(req, 5);
  req.emit('data', Buffer.from('this is way more than 5 bytes'));
  const result = await promise;
  assert.equal(result, null);
});
```

(Prüfe den Kopf von `tests/unit/httpBody.test.js` — falls dort bereits `EventEmitter` importiert und ein Mock-`req`-Muster für `readJsonBody` existiert, dieses Muster 1:1 wiederverwenden statt ein zweites zu erfinden.)

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npm test -- tests/unit/httpBody.test.js`
Expected: FAIL mit `readRawBody is not a function` oder Importfehler.

- [ ] **Step 3: `readRawBody` implementieren**

An `backend/httpBody.js` anhängen:

```js
export function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('error', () => finish(null));
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
  });
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npm test -- tests/unit/httpBody.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/httpBody.js tests/unit/httpBody.test.js
git commit -m "feat: add readRawBody for Stripe webhook signature verification"
```

---

### Task 3: Zahlungsreferenz (Verwendungszweck)

**Files:**
- Create: `backend/payments/reference.js`
- Test: `tests/unit/paymentReference.test.js`

**Interfaces:**
- Produces: `buildPaymentReference(eventId, userId) => string` — kurzer, stabiler String fürs Verwendungszweck-Feld. Wird in Task 9 von `listRegistrationsForUser` verwendet und landet im Frontend als `registration.paymentReference`.

- [ ] **Step 1: Failing Test schreiben**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentReference } from '../../backend/payments/reference.js';

test('buildPaymentReference combines the first 8 chars of eventId and userId, uppercased', () => {
  assert.equal(
    buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    'P-11111111-AAAAAAAA'
  );
});

test('buildPaymentReference is stable for the same inputs', () => {
  const a = buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const b = buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(a, b);
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npm test -- tests/unit/paymentReference.test.js`
Expected: FAIL — Modul existiert nicht.

- [ ] **Step 3: Implementieren**

```js
export function buildPaymentReference(eventId, userId) {
  return `P-${eventId.slice(0, 8)}-${userId.slice(0, 8)}`.toUpperCase();
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npm test -- tests/unit/paymentReference.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/payments/reference.js tests/unit/paymentReference.test.js
git commit -m "feat: add payment reference builder"
```

---

### Task 4: EPC-QR-Payload (Girocode) — reines Frontend-Modul

**Files:**
- Create: `frontend/js/epcQr.js`
- Test: `tests/unit/epcQr.test.js`

**Interfaces:**
- Produces: `buildEpcQrPayload({ iban, bic, name, amountCents, reference }) => string` — der EPC069-12-Textblock, den `frontend/account.html` (Task 12) mit der bereits geladenen `qrcode-generator`-Lib in ein QR-Bild rendert.

- [ ] **Step 1: Failing Test schreiben**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEpcQrPayload } from '../../frontend/js/epcQr.js';

test('buildEpcQrPayload produces the 12-line EPC069-12 SCT payload', () => {
  const payload = buildEpcQrPayload({
    iban: 'DE02100100100006820101',
    bic: 'PBNKDEFF',
    name: 'Pakyrion e.V.',
    amountCents: 4250,
    reference: 'P-11111111-AAAAAAAA',
  });
  assert.deepEqual(payload.split('\n'), [
    'BCD', '002', '1', 'SCT', 'PBNKDEFF', 'Pakyrion e.V.', 'DE02100100100006820101',
    'EUR42.50', '', '', 'P-11111111-AAAAAAAA', '',
  ]);
});

test('buildEpcQrPayload formats whole-euro amounts with two decimal places', () => {
  const payload = buildEpcQrPayload({
    iban: 'DE02100100100006820101', bic: '', name: 'Pakyrion e.V.',
    amountCents: 5000, reference: 'P-1',
  });
  assert.match(payload, /\nEUR50\.00\n/);
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npm test -- tests/unit/epcQr.test.js`
Expected: FAIL — Modul existiert nicht.

- [ ] **Step 3: Implementieren**

```js
// EPC069-12 ("Girocode"): 12 newline-getrennte Felder, die jede SEPA-fähige
// Banking-App als vorausgefüllte Überweisung liest. BIC darf laut Spec seit
// 2020 leer sein (dann übernimmt die App-IBAN-Validierung), leere Felder
// bleiben trotzdem als eigene Zeile stehen.
export function buildEpcQrPayload({ iban, bic, name, amountCents, reference }) {
  const amount = (amountCents / 100).toFixed(2);
  return [
    'BCD',
    '002',
    '1',
    'SCT',
    bic || '',
    name,
    iban,
    `EUR${amount}`,
    '',
    '',
    reference,
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npm test -- tests/unit/epcQr.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/js/epcQr.js tests/unit/epcQr.test.js
git commit -m "feat: add EPC QR (Girocode) payload builder"
```

---

### Task 5: `payment_settings`-Modul (Admin-Einstellungen, Backend)

**Files:**
- Create: `backend/paymentSettings/repository.js`
- Create: `backend/paymentSettings/routes.js`
- Modify: `backend/server.js:26` (Import ergänzen)
- Test: `tests/integration/paymentSettings.test.js`

**Interfaces:**
- Consumes: `query`, `withTransaction` aus `../db.js`; `encryptField`/`decryptField` aus `../crypto/fieldCrypto.js`; `requireAuth`/`requireAdminGroup` wie in `backend/smtpSettings/`.
- Produces: `getPaymentSettings()` (ohne Secrets, mit `hasStripeSecretKey`/`hasStripeWebhookSecret`), `getPaymentSettingsForUse()` (mit entschlüsseltem `stripeSecretKey`/`stripeWebhookSecret`, für Task 6+8), `getBankInfo()` (nur `bankIban`/`bankBic`/`bankAccountHolder`, für den Teilnehmer-Dialog in Task 12), `setPaymentSettings({...})`. Routen: `GET/PUT /admin/settings/payments` (admin), `GET /payment-settings` (jeder eingeloggte Nutzer, nur Bankdaten).

- [ ] **Step 1: Failing Test schreiben**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createServer } = await import('../../backend/server.js');
const { getPaymentSettingsForUse } = await import('../../backend/paymentSettings/repository.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Pay', 'Settings Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`payment-settings-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('PUT then GET /admin/settings/payments never returns plaintext secrets, only has-flags', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');

    const putRes = await fetch(`http://localhost:${port}/admin/settings/payments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        stripeSecretKey: 'sk_test_super_secret', stripeWebhookSecret: 'whsec_super_secret',
        bankIban: 'DE02100100100006820101', bankBic: 'PBNKDEFF', bankAccountHolder: 'Pakyrion e.V.',
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.hasStripeSecretKey, true);
    assert.equal(putBody.hasStripeWebhookSecret, true);
    assert.ok(!JSON.stringify(putBody).includes('super_secret'));

    const getRes = await fetch(`http://localhost:${port}/admin/settings/payments`, { headers: { Cookie: cookie } });
    const getBody = await getRes.json();
    assert.equal(getBody.bankIban, 'DE02100100100006820101');
    assert.ok(!JSON.stringify(getBody).includes('super_secret'));

    const forUse = await getPaymentSettingsForUse();
    assert.equal(forUse.stripeSecretKey, 'sk_test_super_secret');
    assert.equal(forUse.stripeWebhookSecret, 'whsec_super_secret');
  } finally {
    server.close();
  }
});

test('an omitted secret on PUT preserves the previously-saved one', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    await fetch(`http://localhost:${port}/admin/settings/payments`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ stripeSecretKey: 'sk_keep_me', bankIban: 'DE02100100100006820101' }),
    });
    const secondPut = await fetch(`http://localhost:${port}/admin/settings/payments`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ bankIban: 'DE89370400440532013000' }),
    });
    const secondBody = await secondPut.json();
    assert.equal(secondBody.bankIban, 'DE89370400440532013000');
    assert.equal(secondBody.hasStripeSecretKey, true);

    const forUse = await getPaymentSettingsForUse();
    assert.equal(forUse.stripeSecretKey, 'sk_keep_me');
  } finally {
    server.close();
  }
});

test('GET /admin/settings/payments rejects a non-admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/admin/settings/payments`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('GET /payment-settings returns only bank fields to any logged-in user', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    await fetch(`http://localhost:${port}/admin/settings/payments`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ stripeSecretKey: 'sk_should_never_leak', bankIban: 'DE02100100100006820101', bankBic: 'PBNKDEFF', bankAccountHolder: 'Pakyrion e.V.' }),
    });
    const { cookie: memberCookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/payment-settings`, { headers: { Cookie: memberCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { bankIban: 'DE02100100100006820101', bankBic: 'PBNKDEFF', bankAccountHolder: 'Pakyrion e.V.' });
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'payment-settings-%'");
  await query('DELETE FROM payment_settings');
  await closePool();
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npm test -- tests/integration/paymentSettings.test.js`
Expected: FAIL — Routen/Modul existieren nicht (404 bzw. Importfehler).

- [ ] **Step 3: Repository implementieren**

```js
// backend/paymentSettings/repository.js
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

export async function getPaymentSettings() {
  const { rows } = await query(
    `SELECT stripe_secret_key_enc IS NOT NULL AS has_stripe_secret_key,
            stripe_webhook_secret_enc IS NOT NULL AS has_stripe_webhook_secret,
            bank_iban, bank_bic, bank_account_holder
     FROM payment_settings LIMIT 1`
  );
  if (rows.length === 0) {
    return { hasStripeSecretKey: false, hasStripeWebhookSecret: false, bankIban: null, bankBic: null, bankAccountHolder: null };
  }
  return {
    hasStripeSecretKey: rows[0].has_stripe_secret_key,
    hasStripeWebhookSecret: rows[0].has_stripe_webhook_secret,
    bankIban: rows[0].bank_iban,
    bankBic: rows[0].bank_bic,
    bankAccountHolder: rows[0].bank_account_holder,
  };
}

export async function getBankInfo() {
  const { bankIban, bankBic, bankAccountHolder } = await getPaymentSettings();
  return { bankIban, bankBic, bankAccountHolder };
}

function safeDecrypt(buffer) {
  try {
    return decryptField(buffer);
  } catch {
    return null;
  }
}

export async function getPaymentSettingsForUse() {
  const { rows } = await query(
    'SELECT stripe_secret_key_enc, stripe_webhook_secret_enc FROM payment_settings LIMIT 1'
  );
  if (rows.length === 0) return { stripeSecretKey: null, stripeWebhookSecret: null };
  return {
    stripeSecretKey: safeDecrypt(rows[0].stripe_secret_key_enc),
    stripeWebhookSecret: safeDecrypt(rows[0].stripe_webhook_secret_enc),
  };
}

export async function setPaymentSettings({ stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder }) {
  const id = await ensureSettingsRow();
  const stripeSecretKeyEnc = stripeSecretKey ? encryptField(stripeSecretKey) : null;
  const stripeWebhookSecretEnc = stripeWebhookSecret ? encryptField(stripeWebhookSecret) : null;
  await query(
    `UPDATE payment_settings SET
       stripe_secret_key_enc = COALESCE($2, stripe_secret_key_enc),
       stripe_webhook_secret_enc = COALESCE($3, stripe_webhook_secret_enc),
       bank_iban = COALESCE($4, bank_iban),
       bank_bic = COALESCE($5, bank_bic),
       bank_account_holder = COALESCE($6, bank_account_holder)
     WHERE id = $1`,
    [id, stripeSecretKeyEnc, stripeWebhookSecretEnc, bankIban ?? null, bankBic ?? null, bankAccountHolder ?? null]
  );
  return getPaymentSettings();
}

async function ensureSettingsRow() {
  const { rows } = await query('SELECT id FROM payment_settings LIMIT 1');
  if (rows.length > 0) return rows[0].id;
  const { rows: inserted } = await query('INSERT INTO payment_settings DEFAULT VALUES RETURNING id');
  return inserted[0].id;
}
```

- [ ] **Step 4: Routen implementieren**

```js
// backend/paymentSettings/routes.js
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getPaymentSettings, setPaymentSettings, getBankInfo } from './repository.js';

router.get('/admin/settings/payments', requireAuth(requireAdminGroup(async () => {
  const settings = await getPaymentSettings();
  return { status: 200, body: settings };
})));

router.put('/admin/settings/payments', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder } = body;
  const saved = await setPaymentSettings({ stripeSecretKey, stripeWebhookSecret, bankIban, bankBic, bankAccountHolder });
  return { status: 200, body: saved };
})));

router.get('/payment-settings', requireAuth(async () => {
  const bankInfo = await getBankInfo();
  return { status: 200, body: bankInfo };
}));
```

- [ ] **Step 5: In `backend/server.js` registrieren**

In `backend/server.js:26` (direkt nach `import './appSettings/routes.js';`) ergänzen:

```js
import './appSettings/routes.js';
import './paymentSettings/routes.js';
```

- [ ] **Step 6: Test laufen lassen — muss bestehen**

Run: `npm test -- tests/integration/paymentSettings.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/paymentSettings backend/server.js tests/integration/paymentSettings.test.js
git commit -m "feat: add payment settings (Stripe keys, bank details) admin module"
```

---

### Task 6: Stripe-Abhängigkeit + Client-Wrapper

**Files:**
- Modify: `package.json` (via `npm install`)
- Create: `backend/payments/stripeClient.js`

**Interfaces:**
- Consumes: `getPaymentSettingsForUse()` aus `../paymentSettings/repository.js`.
- Produces: `getStripeClient() => Promise<Stripe | null>` — `null` wenn kein Stripe-Secret-Key hinterlegt ist. Wird von Task 8 (Checkout-Session + Webhook) konsumiert.

- [ ] **Step 1: Dependency installieren**

Run: `npm install stripe`
Expected: `package.json`/`package-lock.json` bekommen einen neuen `stripe`-Eintrag unter `dependencies`; Exit-Code 0.

- [ ] **Step 2: Client-Wrapper implementieren**

```js
// backend/payments/stripeClient.js
import Stripe from 'stripe';
import { getPaymentSettingsForUse } from '../paymentSettings/repository.js';

export async function getStripeClient() {
  const { stripeSecretKey } = await getPaymentSettingsForUse();
  if (!stripeSecretKey) return null;
  return new Stripe(stripeSecretKey);
}
```

Kein eigener Test für diese Datei: Sie ist ein dünner Wrapper um Repository-Aufruf + SDK-Konstruktor, ohne eigene Logik — die Fälle "kein Key gesetzt" und "Key gesetzt" werden bereits über die Route-Tests in Task 8 abgedeckt (die diesen Wrapper durchlaufen).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json backend/payments/stripeClient.js
git commit -m "feat: add Stripe SDK dependency and client wrapper"
```

---

### Task 7: Payments-Repository (Betrag setzen, manuell bestätigen, Stripe-Zahlung verbuchen)

**Files:**
- Create: `backend/payments/repository.js`
- Test: `tests/integration/payments.test.js` (Step 1 dieses Tasks — Step 1 von Task 8 erweitert dieselbe Datei)

**Interfaces:**
- Consumes: `query`, `withTransaction` aus `../db.js`.
- Produces: `setAmountDue(eventId, userId, amountDueCents)`, `markPaidManually(eventId, userId, confirmedByUserId)`, `markUnpaid(eventId, userId)`, `recordSuccessfulStripePayment({eventId, userId, method, amountCents, providerReference})` — jede wirft `err.code = 'REGISTRATION_NOT_FOUND'` wenn die Registrierung fehlt; `markPaidManually` wirft zusätzlich `err.code = 'NO_AMOUNT_DUE'`, wenn kein Betrag hinterlegt ist. Alle geben `{ userId, eventId, amountDueCents, paidAt }` zurück (außer `recordSuccessfulStripePayment`, das nichts zurückgibt — der Webhook-Handler in Task 8 braucht keinen Rückgabewert).

- [ ] **Step 1: Failing Test schreiben**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const {
  setAmountDue, markPaidManually, markUnpaid, recordSuccessfulStripePayment,
} = await import('../../backend/payments/repository.js');

async function makeUser() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Pay', 'Repo Test', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`payments-repo-${crypto.randomUUID()}@example.com`]
  );
  return rows[0].id;
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active) VALUES ('Payments Repo Test Con', '2027-08-01', true) RETURNING id"
  );
  return rows[0].id;
}

async function makeRegistration(eventId, userId) {
  await query(
    "INSERT INTO registrations (user_id, event_id, con_role, status) VALUES ($1, $2, 'helfer', 'confirmed')",
    [userId, eventId]
  );
}

test('setAmountDue then markPaidManually gates and ungates the registration', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  const adminId = await makeUser();
  await makeRegistration(eventId, userId);

  const afterSet = await setAmountDue(eventId, userId, 4500);
  assert.equal(afterSet.amountDueCents, 4500);
  assert.equal(afterSet.paidAt, null);

  const afterPaid = await markPaidManually(eventId, userId, adminId);
  assert.ok(afterPaid.paidAt);

  const { rows } = await query('SELECT method, amount_cents, confirmed_by FROM payments WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].method, 'bank_transfer');
  assert.equal(rows[0].amount_cents, 4500);
  assert.equal(rows[0].confirmed_by, adminId);
});

test('markPaidManually rejects a registration with no amount due', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  const adminId = await makeUser();
  await makeRegistration(eventId, userId);

  await assert.rejects(
    () => markPaidManually(eventId, userId, adminId),
    (err) => err.code === 'NO_AMOUNT_DUE'
  );
});

test('markUnpaid clears paidAt without deleting the payment history', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  const adminId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 2000);
  await markPaidManually(eventId, userId, adminId);

  const afterReset = await markUnpaid(eventId, userId);
  assert.equal(afterReset.paidAt, null);

  const { rows } = await query('SELECT count(*)::int AS count FROM payments WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.equal(rows[0].count, 1);
});

test('recordSuccessfulStripePayment sets paidAt and is idempotent on the same providerReference', async () => {
  const eventId = await makeEvent();
  const userId = await makeUser();
  await makeRegistration(eventId, userId);
  await setAmountDue(eventId, userId, 3000);

  await recordSuccessfulStripePayment({ eventId, userId, method: 'stripe_card', amountCents: 3000, providerReference: 'cs_test_123' });
  const { rows: afterFirst } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.ok(afterFirst[0].paid_at);
  const firstPaidAt = afterFirst[0].paid_at;

  // Stripe retries webhooks -- a second delivery of the same event must not
  // create a second payments row or move paid_at.
  await recordSuccessfulStripePayment({ eventId, userId, method: 'stripe_card', amountCents: 3000, providerReference: 'cs_test_123' });
  const { rows: countRows } = await query('SELECT count(*)::int AS count FROM payments WHERE provider_reference = $1', ['cs_test_123']);
  assert.equal(countRows[0].count, 1);
  const { rows: afterSecond } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  assert.deepEqual(afterSecond[0].paid_at, firstPaidAt);
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'payments-repo-%'");
  await query("DELETE FROM events WHERE name = 'Payments Repo Test Con'");
  await closePool();
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npm test -- tests/integration/payments.test.js`
Expected: FAIL — `backend/payments/repository.js` existiert nicht.

- [ ] **Step 3: Repository implementieren**

```js
// backend/payments/repository.js
import { query, withTransaction } from '../db.js';

function mapRegistrationRow(r) {
  return { userId: r.user_id, eventId: r.event_id, amountDueCents: r.amount_due_cents, paidAt: r.paid_at };
}

async function getRegistrationOrThrow(client, eventId, userId) {
  const { rows } = await client.query(
    'SELECT user_id, event_id, amount_due_cents, paid_at FROM registrations WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
    [eventId, userId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return rows[0];
}

export async function setAmountDue(eventId, userId, amountDueCents) {
  const { rows } = await query(
    `UPDATE registrations SET amount_due_cents = $3 WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, amount_due_cents, paid_at`,
    [eventId, userId, amountDueCents]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return mapRegistrationRow(rows[0]);
}

export async function markPaidManually(eventId, userId, confirmedByUserId) {
  return withTransaction(async (client) => {
    const registration = await getRegistrationOrThrow(client, eventId, userId);
    if (registration.amount_due_cents == null) {
      const err = new Error('Kein Betrag hinterlegt.');
      err.code = 'NO_AMOUNT_DUE';
      throw err;
    }
    await client.query(
      `INSERT INTO payments (user_id, event_id, method, amount_cents, confirmed_by)
       VALUES ($1, $2, 'bank_transfer', $3, $4)`,
      [userId, eventId, registration.amount_due_cents, confirmedByUserId]
    );
    const { rows } = await client.query(
      `UPDATE registrations SET paid_at = COALESCE(paid_at, now()) WHERE event_id = $1 AND user_id = $2
       RETURNING user_id, event_id, amount_due_cents, paid_at`,
      [eventId, userId]
    );
    return mapRegistrationRow(rows[0]);
  });
}

export async function markUnpaid(eventId, userId) {
  const { rows } = await query(
    `UPDATE registrations SET paid_at = NULL WHERE event_id = $1 AND user_id = $2
     RETURNING user_id, event_id, amount_due_cents, paid_at`,
    [eventId, userId]
  );
  if (rows.length === 0) {
    const err = new Error('registration not found');
    err.code = 'REGISTRATION_NOT_FOUND';
    throw err;
  }
  return mapRegistrationRow(rows[0]);
}

// Called from the Stripe webhook, which Stripe retries on any non-2xx or
// timeout -- ON CONFLICT DO NOTHING on provider_reference plus
// COALESCE(paid_at, now()) makes replays of the exact same event a no-op
// instead of a duplicate payments row or a paid_at that jumps forward.
export async function recordSuccessfulStripePayment({ eventId, userId, method, amountCents, providerReference }) {
  await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT 1 FROM registrations WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
    if (existing.length === 0) {
      const err = new Error('registration not found');
      err.code = 'REGISTRATION_NOT_FOUND';
      throw err;
    }
    const { rowCount } = await client.query(
      `INSERT INTO payments (user_id, event_id, method, amount_cents, provider_reference)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_reference) DO NOTHING`,
      [userId, eventId, method, amountCents, providerReference]
    );
    if (rowCount === 0) return; // already recorded by an earlier delivery of the same webhook event
    await client.query(
      'UPDATE registrations SET paid_at = COALESCE(paid_at, now()) WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );
  });
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npm test -- tests/integration/payments.test.js`
Expected: PASS (4 Tests)

- [ ] **Step 5: Commit**

```bash
git add backend/payments/repository.js tests/integration/payments.test.js
git commit -m "feat: add payments repository (manual confirm, Stripe webhook recording)"
```

---

### Task 8: Payments-Routen (Checkout-Session, Webhook, Admin-PATCH)

**Files:**
- Create: `backend/payments/routes.js`
- Modify: `backend/server.js` (Import ergänzen)
- Modify: `tests/integration/payments.test.js` (erweitert dieselbe Datei aus Task 7 um Routen-Tests)

**Interfaces:**
- Consumes: `getStripeClient` (Task 6), `setAmountDue`/`markPaidManually`/`markUnpaid`/`recordSuccessfulStripePayment` (Task 7), `getPaymentSettingsForUse` (Task 5), `readRawBody` (Task 2), `getEvent` aus `../events/repository.js`, `baseUrl` aus `../auth/mailer.js`, `requireAuth`/`requireMenu` (bestehend).
- Produces: `POST /events/:eventId/registrations/:userId/checkout-session`, `POST /webhooks/stripe`, `PATCH /events/:eventId/registrations/:userId/payment`.

- [ ] **Step 1: Failing Tests an `tests/integration/payments.test.js` anhängen**

Vor `test.after` einfügen (bestehende Imports oben in der Datei wiederverwenden, `withTestServer` und `createSession` ergänzend importieren wie in `tests/integration/registrations.test.js`):

```js
import { withTestServer } from '../testServer.js';
import { createSession } from '../../backend/auth/sessions.js';
import Stripe from 'stripe';

async function makeSession(userId) {
  const session = await createSession(userId);
  return `session=${session.token}`;
}

async function makeCheckinGroupUserAndSession() {
  const key = `payments_checkin_${crypto.randomUUID().slice(0, 8)}`;
  await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status)
     VALUES ($1, $2, '["checkin"]', '[]', false, true)`,
    [key, key]
  );
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Pay', 'Checkin', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`payments-checkin-${crypto.randomUUID()}@example.com`, key]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

test('POST checkout-session rejects a registration with no amount due', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    const cookie = await makeSession(userId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST checkout-session rejects a caller who is not the registration owner', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 1000);
    const otherUserId = await makeUser();
    const cookie = await makeSession(otherUserId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 403);
  });
});

test('POST checkout-session rejects an already-paid registration', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const userId = await makeUser();
    const adminId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 1000);
    await markPaidManually(eventId, userId, adminId);
    const cookie = await makeSession(userId);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ method: 'card' }),
    });
    assert.equal(res.status, 409);
  });
});

test('POST /webhooks/stripe with an invalid signature is rejected', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'not-a-real-signature' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /webhooks/stripe marks the registration paid on a validly-signed checkout.session.completed', async () => {
  await withTestServer(async (port) => {
    const { cookie: adminCookie } = await (async () => {
      const id = await makeUser();
      await query("UPDATE users SET group_id = (SELECT id FROM groups WHERE key = 'admin') WHERE id = $1", [id]);
      return { userId: id, cookie: await makeSession(id) };
    })();
    const webhookSecret = 'whsec_test_secret';
    await fetch(`http://localhost:${port}/admin/settings/payments`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ stripeSecretKey: 'sk_test_dummy', stripeWebhookSecret: webhookSecret }),
    });

    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);
    await setAmountDue(eventId, userId, 2500);

    const payload = JSON.stringify({
      id: 'evt_test_1', type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_webhook_1', client_reference_id: `${eventId}:${userId}`, amount_total: 2500, payment_method_types: ['card'] } },
    });
    // Stripe's own test helper for generating a locally-valid signature --
    // no network call, matches how Stripe's docs recommend testing webhook
    // handlers offline.
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

    const res = await fetch(`http://localhost:${port}/webhooks/stripe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    assert.equal(res.status, 200);

    const { rows } = await query('SELECT paid_at FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    assert.ok(rows[0].paid_at);
  });
});

test('PATCH .../payment lets checkin-menu staff set an amount and mark paid, and rejects a plain member', async () => {
  await withTestServer(async (port) => {
    const { cookie: staffCookie } = await makeCheckinGroupUserAndSession();
    const eventId = await makeEvent();
    const userId = await makeUser();
    await makeRegistration(eventId, userId);

    const setAmountRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ amountDueCents: 3000 }),
    });
    assert.equal(setAmountRes.status, 200);
    assert.equal((await setAmountRes.json()).amountDueCents, 3000);

    const markPaidRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ markPaid: true }),
    });
    assert.equal(markPaidRes.status, 200);
    assert.ok((await markPaidRes.json()).paidAt);

    const memberCookie = await makeSession(await makeUser());
    const forbiddenRes = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ amountDueCents: 1000 }),
    });
    assert.equal(forbiddenRes.status, 403);
  });
});
```

(`setAmountDue`/`markPaidManually` müssen im Test-Import oben in der Datei bereits vorhanden sein — sind es, aus Task 7.)

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npm test -- tests/integration/payments.test.js`
Expected: FAIL — Routen existieren nicht (404en) bzw. Server kennt `/webhooks/stripe` nicht.

- [ ] **Step 3: Routen implementieren**

```js
// backend/payments/routes.js
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { readJsonBody, readRawBody } from '../httpBody.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { getEvent } from '../events/repository.js';
import { baseUrl } from '../auth/mailer.js';
import { getStripeClient } from './stripeClient.js';
import { getPaymentSettingsForUse } from '../paymentSettings/repository.js';
import {
  setAmountDue, markPaidManually, markUnpaid, recordSuccessfulStripePayment,
} from './repository.js';

const CHECKOUT_METHODS = { card: 'stripe_card', paypal: 'stripe_paypal' };

router.post('/events/:eventId/registrations/:userId/checkout-session', requireAuth(async ({ req, params, user }) => {
  if (params.userId !== user.id) return { status: 403, body: { error: 'forbidden' } };
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const stripeMethod = CHECKOUT_METHODS[body.method];
  if (!stripeMethod) return { status: 400, body: { error: 'method must be one of: card, paypal' } };

  const { rows } = await query(
    'SELECT amount_due_cents, paid_at FROM registrations WHERE event_id = $1 AND user_id = $2',
    [params.eventId, params.userId]
  );
  if (rows.length === 0) return { status: 404, body: { error: 'registration not found' } };
  if (rows[0].amount_due_cents == null) return { status: 400, body: { error: 'Für diese Anmeldung ist kein Betrag hinterlegt.' } };
  if (rows[0].paid_at) return { status: 409, body: { error: 'Bereits bezahlt.' } };

  const stripe = await getStripeClient();
  if (!stripe) return { status: 502, body: { error: 'Zahlungen sind aktuell nicht konfiguriert.' } };

  const event = await getEvent(params.eventId);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: [body.method],
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: rows[0].amount_due_cents,
        product_data: { name: `Teilnahmegebühr – ${event?.name ?? 'Event'}` },
      },
      quantity: 1,
    }],
    client_reference_id: `${params.eventId}:${params.userId}`,
    success_url: `${baseUrl()}/account.html?payment=success#veranstaltung`,
    cancel_url: `${baseUrl()}/account.html?payment=cancelled#veranstaltung`,
  });
  return { status: 200, body: { url: session.url } };
}));

router.post('/webhooks/stripe', async ({ req }) => {
  const rawBody = await readRawBody(req);
  if (rawBody === null) return { status: 400, body: { error: 'invalid body' } };

  const { stripeWebhookSecret } = await getPaymentSettingsForUse();
  const stripe = await getStripeClient();
  if (!stripe || !stripeWebhookSecret) return { status: 503, body: { error: 'Stripe ist nicht konfiguriert.' } };

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], stripeWebhookSecret);
  } catch (err) {
    logger.error('stripe webhook signature verification failed', { error: err.message });
    return { status: 400, body: { error: 'invalid signature' } };
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const [eventId, userId] = (session.client_reference_id || '').split(':');
    if (eventId && userId) {
      try {
        await recordSuccessfulStripePayment({
          eventId, userId,
          method: session.payment_method_types?.includes('paypal') ? 'stripe_paypal' : 'stripe_card',
          amountCents: session.amount_total,
          providerReference: session.id,
        });
      } catch (err) {
        // Always 200 back to Stripe even on our own failure to process
        // (e.g. the registration was deleted in the meantime) -- a non-2xx
        // here makes Stripe retry the same event indefinitely.
        logger.error('failed to record stripe payment', { error: err.message, eventId, userId, sessionId: session.id });
      }
    }
  }

  return { status: 200, body: { received: true } };
});

router.patch('/events/:eventId/registrations/:userId/payment', requireAuth(requireMenu('checkin')(async ({ req, params, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  try {
    if (body.amountDueCents !== undefined) {
      if (body.amountDueCents !== null && (!Number.isInteger(body.amountDueCents) || body.amountDueCents < 0)) {
        return { status: 400, body: { error: 'amountDueCents must be a non-negative integer or null' } };
      }
      const registration = await setAmountDue(params.eventId, params.userId, body.amountDueCents);
      return { status: 200, body: registration };
    }
    if (body.markPaid === true) {
      const registration = await markPaidManually(params.eventId, params.userId, user.id);
      return { status: 200, body: registration };
    }
    if (body.markPaid === false) {
      const registration = await markUnpaid(params.eventId, params.userId);
      return { status: 200, body: registration };
    }
    return { status: 400, body: { error: 'expected amountDueCents or markPaid' } };
  } catch (err) {
    if (err.code === 'REGISTRATION_NOT_FOUND') return { status: 404, body: { error: 'registration not found' } };
    if (err.code === 'NO_AMOUNT_DUE') return { status: 409, body: { error: err.message } };
    throw err;
  }
})));
```

- [ ] **Step 4: In `backend/server.js` registrieren**

```js
import './paymentSettings/routes.js';
import './payments/routes.js';
```

- [ ] **Step 5: Tests laufen lassen — müssen bestehen**

Run: `npm test -- tests/integration/payments.test.js`
Expected: PASS (alle Tests aus Task 7 + Task 8)

- [ ] **Step 6: Commit**

```bash
git add backend/payments/routes.js backend/server.js tests/integration/payments.test.js
git commit -m "feat: add checkout-session, Stripe webhook, and admin payment routes"
```

---

### Task 9: Zahlungsdaten in `/registrations` und `/events/:id/participants` freigeben

**Files:**
- Modify: `backend/registrations/repository.js:454-481` (`listRegistrationsForUser`), `backend/registrations/repository.js:358-423` (`listParticipantsForEvent`)
- Test: `tests/integration/registrations.test.js` (neue Assertions), `tests/integration/checkin.test.js` (neue Assertions)

**Interfaces:**
- Consumes: `buildPaymentReference` aus `../payments/reference.js` (Task 3).
- Produces: `listRegistrationsForUser` liefert jetzt zusätzlich `amountDueCents`, `paidAt`, `paymentReference` pro Registrierung; `listParticipantsForEvent` liefert zusätzlich `amountDueCents`, `paidAt`, `paymentMethod` (Methode der letzten erfassten Zahlung, `null` wenn noch keine).

- [ ] **Step 1: Failing Assertions ergänzen**

In `tests/integration/registrations.test.js`, im bestehenden Test `'a participant can register and unregister for an event'` (oder als neuer Test direkt danach) ergänzen:

```js
test('listed registrations include payment fields', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const characterId = await makeCharacter(port, cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });

    const res = await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: cookie } });
    const [registration] = await res.json();
    assert.equal(registration.amountDueCents, null);
    assert.equal(registration.paidAt, null);
    assert.match(registration.paymentReference, /^P-[0-9A-F]{8}-[0-9A-F]{8}$/);
  });
});
```

In `tests/integration/checkin.test.js` (Struktur analog prüfen — `listParticipantsForEvent` wird dort über `GET /events/:id/participants` getestet) einen Test analog ergänzen, der nach `PATCH .../payment` mit `amountDueCents` prüft, dass `GET /events/:id/participants` `amountDueCents`/`paidAt`/`paymentMethod` im passenden Eintrag zurückgibt.

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npm test -- tests/integration/registrations.test.js tests/integration/checkin.test.js`
Expected: FAIL — `amountDueCents`/`paidAt`/`paymentReference`/`paymentMethod` fehlen in der Response.

- [ ] **Step 3: `listRegistrationsForUser` erweitern**

In `backend/registrations/repository.js` oben den Import ergänzen:

```js
import { buildPaymentReference } from '../payments/reference.js';
```

Die Funktion `listRegistrationsForUser` (aktuell Zeilen 454-481) wie folgt ändern — SELECT um `r.amount_due_cents, r.paid_at` erweitern und die Rückgabe um die drei neuen Felder ergänzen:

```js
export async function listRegistrationsForUser(userId) {
  const { rows } = await query(
    `SELECT r.event_id, e.name AS event_name, e.event_date, r.status, r.con_role, r.character_id, r.nsc_available, r.nsc_character_id, r.checked_in_at, r.checked_out_at,
            r.amount_due_cents, r.paid_at,
            r.registration_data_enc, c.name AS character_name, nc.name AS nsc_character_name
     FROM registrations r
     JOIN events e ON e.id = r.event_id
     LEFT JOIN characters c ON c.id = r.character_id
     LEFT JOIN characters nc ON nc.id = r.nsc_character_id
     WHERE r.user_id = $1
     ORDER BY e.event_date`,
    [userId]
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    eventName: r.event_name,
    eventDate: r.event_date,
    status: r.status,
    conRole: r.con_role,
    characterId: r.character_id,
    characterName: r.character_name,
    nscAvailable: r.nsc_available,
    nscCharacterId: r.nsc_character_id,
    nscCharacterName: r.nsc_character_name,
    checkedInAt: r.checked_in_at,
    checkedOutAt: r.checked_out_at,
    amountDueCents: r.amount_due_cents,
    paidAt: r.paid_at,
    paymentReference: buildPaymentReference(r.event_id, userId),
    ...decryptFieldBlob(r.registration_data_enc),
  }));
}
```

- [ ] **Step 4: `listParticipantsForEvent` erweitern**

Die erste Query in `listParticipantsForEvent` (aktuell Zeilen 361-369) um `amount_due_cents`, `paid_at` und die letzte Zahlungsmethode per LATERAL-Join erweitern:

```js
  const { rows: registrations } = await query(
    `SELECT r.user_id, u.first_name, u.last_name, u.nickname, r.status, r.con_role, r.nsc_available, r.nsc_character_id, r.checked_in_at, r.checked_out_at,
            r.amount_due_cents, r.paid_at, latest_payment.method AS payment_method,
            u.account_data_enc, r.registration_data_enc
     FROM registrations r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN LATERAL (
       SELECT method FROM payments p
       WHERE p.event_id = r.event_id AND p.user_id = r.user_id
       ORDER BY p.created_at DESC LIMIT 1
     ) latest_payment ON true
     WHERE r.event_id = $1
     ORDER BY u.last_name, u.first_name`,
    [eventId]
  );
```

Im `registered = registrations.map(...)`-Block (aktuell Zeilen 388-409) die Rückgabe um die drei Felder ergänzen:

```js
    return {
      userId: r.user_id,
      invitationId: null,
      name: displayName({ firstName: r.first_name, lastName: r.last_name, nickname: r.nickname }),
      status: r.status,
      conRole: r.con_role,
      nscAvailable: r.nsc_available,
      nscCharacterId: r.nsc_character_id,
      checkedInAt: r.checked_in_at,
      checkedOutAt: r.checked_out_at,
      amountDueCents: r.amount_due_cents,
      paidAt: r.paid_at,
      paymentMethod: r.payment_method,
      characters: charactersByUser.get(r.user_id) ?? [],
      otFields,
    };
```

Und im `notified = (...)`-Block (Zeilen 411-420, für offene Einladungen ohne Registrierung) die drei Felder als `null` ergänzen, damit jeder Eintrag dieselbe Form hat:

```js
  const notified = (await listOpenInvitationsForEvent(eventId)).map((inv) => ({
    userId: null,
    invitationId: inv.invitationId,
    name: inv.name,
    status: 'notified',
    checkedInAt: null,
    checkedOutAt: null,
    amountDueCents: null,
    paidAt: null,
    paymentMethod: null,
    characters: [],
    otFields: {},
  }));
```

- [ ] **Step 5: Tests laufen lassen — müssen bestehen**

Run: `npm test -- tests/integration/registrations.test.js tests/integration/checkin.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/registrations/repository.js tests/integration/registrations.test.js tests/integration/checkin.test.js
git commit -m "feat: expose payment fields on registrations and participant listings"
```

---

### Task 10: Admin-Einstellungen — Zahlungen-Sektion

**Files:**
- Modify: `frontend/admin/settings.html`

**Interfaces:**
- Consumes: `GET/PUT /admin/settings/payments` (Task 5).

- [ ] **Step 1: HTML-Card ergänzen**

In `frontend/admin/settings.html`, direkt nach der bestehenden `<div class="card form-pad">...Warteliste...</div>`-Card (vor der "Charaktere durchsuchen"-Card) einfügen:

```html
<div class="card form-pad">
  <h2>Zahlungen</h2>
  <p class="sub">Stripe verarbeitet PayPal- und Kreditkartenzahlungen. Für die manuelle Überweisung werden Kontodaten angezeigt.</p>
  <form id="payment-settings-form">
    <label for="stripe-secret-key">Stripe Secret Key</label>
    <input id="stripe-secret-key" name="stripeSecretKey" type="password" placeholder="Leer lassen, um den bestehenden Key zu behalten">
    <label for="stripe-webhook-secret">Stripe Webhook Signing Secret</label>
    <input id="stripe-webhook-secret" name="stripeWebhookSecret" type="password" placeholder="Leer lassen, um das bestehende Secret zu behalten">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div>
        <label for="bank-iban">IBAN</label>
        <input id="bank-iban" name="bankIban" type="text">
      </div>
      <div>
        <label for="bank-bic">BIC</label>
        <input id="bank-bic" name="bankBic" type="text">
      </div>
    </div>
    <label for="bank-account-holder">Kontoinhaber</label>
    <input id="bank-account-holder" name="bankAccountHolder" type="text">
    <button type="submit">Speichern</button>
  </form>
</div>
```

- [ ] **Step 2: JS-Wiring ergänzen**

Im `<script type="module">`-Block, nach dem bestehenden `loadWaitlistSetting`-Block, ergänzen:

```js
const paymentSettingsForm = document.getElementById('payment-settings-form');

async function loadPaymentSettings() {
  const settings = await api.get('/admin/settings/payments');
  paymentSettingsForm.elements.bankIban.value = settings.bankIban ?? '';
  paymentSettingsForm.elements.bankBic.value = settings.bankBic ?? '';
  paymentSettingsForm.elements.bankAccountHolder.value = settings.bankAccountHolder ?? '';
  paymentSettingsForm.elements.stripeSecretKey.placeholder = settings.hasStripeSecretKey
    ? 'Gesetzt — leer lassen, um ihn zu behalten' : 'Leer lassen, um den bestehenden Key zu behalten';
  paymentSettingsForm.elements.stripeWebhookSecret.placeholder = settings.hasStripeWebhookSecret
    ? 'Gesetzt — leer lassen, um es zu behalten' : 'Leer lassen, um das bestehende Secret zu behalten';
}

paymentSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(paymentSettingsForm));
  try {
    await api.put('/admin/settings/payments', data);
    notify('Gespeichert.', 'success');
    paymentSettingsForm.elements.stripeSecretKey.value = '';
    paymentSettingsForm.elements.stripeWebhookSecret.value = '';
    await loadPaymentSettings();
  } catch (err) {
    notify(err.message, 'error');
  }
});
```

Im abschließenden `try { ... }`-Block am Dateiende, nach `await loadWaitlistSetting();`, ergänzen:

```js
  await loadPaymentSettings();
```

- [ ] **Step 3: Manuell prüfen**

Dev-Server starten (`docker compose -f docker-compose.dev.yml up`), als Admin auf `/admin/settings.html` einloggen, Stripe-Testkeys + IBAN/BIC/Kontoinhaber eintragen, speichern, Seite neu laden — Felder müssen leer bleiben (Platzhalter zeigt "Gesetzt"), Bankdaten müssen erhalten bleiben.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin/settings.html
git commit -m "feat: add payment settings (Stripe keys, bank details) to admin settings UI"
```

---

### Task 11: Admin Check-In — Betrag & Zahlungsstatus pro Teilnehmer

**Files:**
- Modify: `frontend/admin/checkin.html`

**Interfaces:**
- Consumes: `amountDueCents`/`paidAt`/`paymentMethod` aus `GET /events/:id/participants` (Task 9); `PATCH /events/:id/registrations/:userId/payment` (Task 8).

- [ ] **Step 1: Neue Spalten in `renderTableHead` ergänzen**

In `frontend/admin/checkin.html`, Funktion `renderTableHead` (aktuell Zeile 171), das Betrag/Zahlung-Spaltenpaar vor der Status-Spalte einfügen:

```js
  tableHeadRow.innerHTML = `<div class="grid-cell" role="columnheader">Name</div><div class="grid-cell" role="columnheader">Charaktere</div><div class="grid-cell" role="columnheader">Rolle</div>${extraTh}<div class="grid-cell" role="columnheader">Betrag</div><div class="grid-cell" role="columnheader">Zahlung</div><div class="grid-cell" role="columnheader">Status</div><div class="grid-cell" role="columnheader"></div><div class="grid-cell" role="columnheader"></div><div class="grid-cell" role="columnheader"></div><div class="grid-cell" role="columnheader"></div><div class="grid-cell" role="columnheader"></div><div class="grid-cell" role="columnheader">Override</div>`;
```

- [ ] **Step 2: Render-Funktionen für die zwei neuen Zellen ergänzen**

Nach der bestehenden Funktion `renderConRoleCell` (endet Zeile 458) einfügen:

```js
const PAYMENT_METHOD_LABELS = { stripe_card: 'Karte', stripe_paypal: 'PayPal', bank_transfer: 'Überweisung' };

function renderAmountDueCell(p) {
  if (!p.userId) return '';
  const value = p.amountDueCents != null ? (p.amountDueCents / 100).toFixed(2) : '';
  return `<input type="number" min="0" step="0.01" data-amount-due="${escapeHtml(p.userId)}" value="${escapeHtml(value)}" placeholder="kein Betrag" style="width:90px;">`;
}

function renderPaymentStatusCell(p) {
  if (!p.userId) return '';
  if (p.amountDueCents == null) return '<span class="sub">–</span>';
  if (p.paidAt) {
    const label = PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod ?? 'manuell';
    return `<span class="status-pill status-confirmed">Bezahlt (${escapeHtml(label)})</span> <button type="button" class="btn-ghost" data-mark-unpaid="${escapeHtml(p.userId)}">Zurücksetzen</button>`;
  }
  return `<span class="status-pill status-pending">Offen</span> <button type="button" class="btn-ghost" data-mark-paid="${escapeHtml(p.userId)}">Als bezahlt markieren</button>`;
}
```

- [ ] **Step 3: Zellen in `loadParticipants` einbauen und Handler verdrahten**

In der Template-Zeile von `loadParticipants` (aktuell Zeile 512-524), nach `${renderExtraCells(p)}` und vor der Status-Zelle einfügen:

```js
    <div class="grid-cell">${renderAmountDueCell(p)}</div>
    <div class="grid-cell">${renderPaymentStatusCell(p)}</div>
```

Direkt nach dem bestehenden `listBody.querySelectorAll('[data-con-role]')...`-Block (Zeile 547-549) ergänzen:

```js
  listBody.querySelectorAll('[data-amount-due]').forEach((input) => {
    input.addEventListener('change', () => setAmountDue(eventId, input.dataset.amountDue, input.value));
  });
  listBody.querySelectorAll('[data-mark-paid]').forEach((button) => {
    button.addEventListener('click', () => setPaymentStatus(eventId, button.dataset.markPaid, true));
  });
  listBody.querySelectorAll('[data-mark-unpaid]').forEach((button) => {
    button.addEventListener('click', () => setPaymentStatus(eventId, button.dataset.markUnpaid, false));
  });
```

Nach der bestehenden Funktion `promoteConRole` (endet Zeile 608) ergänzen:

```js
async function setAmountDue(eventId, userId, euroValue) {
  const amountDueCents = euroValue === '' ? null : Math.round(Number(euroValue) * 100);
  try {
    await api.patch(`/events/${eventId}/registrations/${userId}/payment`, { amountDueCents });
    await loadParticipants(eventId);
  } catch (err) {
    notify(err.message, 'error');
    await loadParticipants(eventId);
  }
}

async function setPaymentStatus(eventId, userId, markPaid) {
  try {
    await api.patch(`/events/${eventId}/registrations/${userId}/payment`, { markPaid });
    await loadParticipants(eventId);
  } catch (err) {
    notify(err.message, 'error');
    await loadParticipants(eventId);
  }
}
```

- [ ] **Step 4: Manuell prüfen**

Auf `/admin/checkin.html` als Admin/Orga: Betrag bei einem Teilnehmer setzen (Feld verlässt Fokus → speichert), "Als bezahlt markieren" klicken → Status wechselt zu "Bezahlt (Überweisung)" mit "Zurücksetzen"-Button; erneut klicken → zurück zu "Offen".

- [ ] **Step 5: Commit**

```bash
git add frontend/admin/checkin.html
git commit -m "feat: add amount-due and payment-status columns to admin check-in list"
```

---

### Task 12: Dashboard — Ticket-Gate & "Jetzt zahlen"-Dialog

**Files:**
- Modify: `frontend/account.html`

**Interfaces:**
- Consumes: `amountDueCents`/`paidAt`/`paymentReference` aus `GET /registrations` (Task 9); `POST /events/:eventId/registrations/:userId/checkout-session` (Task 8); `GET /payment-settings` (Task 5); `buildEpcQrPayload` (Task 4).

- [ ] **Step 1: Ticket-Panel um Zahlungs-Hinweis/Button erweitern**

In `frontend/account.html`, im `.ticket-actions`-Block (aktuell Zeilen 71-74), Hinweis und Button ergänzen:

```html
              <div class="ticket-actions">
                <button type="button" id="ticket-download-png">Ticket herunterladen (PNG)</button>
                <button type="button" id="ticket-download-pdf" class="btn-secondary">Als PDF</button>
              </div>
              <p class="sub" id="ticket-payment-hint" style="display:none;"></p>
              <button type="button" id="ticket-pay-btn" style="display:none;">Jetzt zahlen</button>
```

- [ ] **Step 2: Zahlungs-Dialog-Markup ergänzen**

Direkt vor dem schließenden `</body>` (nach dem bestehenden `photo-upload-dialog`), einfügen:

```html
  <dialog id="payment-dialog">
    <h3>Zahlung</h3>
    <p class="lede">Zu zahlen: <strong id="payment-dialog-amount"></strong></p>
    <div class="dialog-actions">
      <button type="button" id="payment-paypal-btn">Per PayPal</button>
      <button type="button" id="payment-card-btn">Per Kreditkarte</button>
      <button type="button" id="payment-bank-btn" class="btn-ghost">Überweisungsinformationen anzeigen</button>
      <button type="button" id="payment-girocode-btn" class="btn-ghost">Girocode anzeigen</button>
    </div>
    <div id="payment-bank-info" style="display:none;">
      <p>IBAN: <span id="payment-bank-iban"></span></p>
      <p>BIC: <span id="payment-bank-bic"></span></p>
      <p>Kontoinhaber: <span id="payment-bank-holder"></span></p>
      <p>Verwendungszweck: <strong id="payment-bank-reference"></strong></p>
    </div>
    <div id="payment-girocode-wrap" style="display:none;">
      <canvas id="payment-girocode-canvas"></canvas>
    </div>
    <button type="button" id="payment-dialog-close" class="btn-ghost">Schließen</button>
  </dialog>
```

- [ ] **Step 3: `epcQr.js` importieren und bestehende QR-Zeichenlogik in eine wiederverwendbare Funktion extrahieren**

Im `<script type="module">`-Block, Import-Liste ergänzen (nach dem bestehenden `buildScanCode`-Import):

```js
    import { buildScanCode } from "/js/qrCode.js";
    import { buildEpcQrPayload } from "/js/epcQr.js";
```

Die bestehende Canvas-Zeichenschleife in `loadQrCode` (aktuell Zeilen 521-538 — von `const qr = qrcode(0, "M");` bis zum Ende der Doppelschleife) durch einen Aufruf einer neuen, gemeinsamen Hilfsfunktion ersetzen. Zuerst die Hilfsfunktion direkt vor `function showTicketHint(...)` (Zeile 486) einfügen:

```js
    function renderQrToCanvas(text, canvas) {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const moduleCount = qr.getModuleCount();
      const cellSize = 6;
      canvas.width = moduleCount * cellSize;
      canvas.height = moduleCount * cellSize;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000000";
      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          if (qr.isDark(row, col)) ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
      }
    }
```

Dann in `loadQrCode` den Block

```js
        const qr = qrcode(0, "M");
        qr.addData(code);
        qr.make();
        const moduleCount = qr.getModuleCount();
        const cellSize = 6;
        const canvas = document.getElementById("qr-canvas");
        canvas.width = moduleCount * cellSize;
        canvas.height = moduleCount * cellSize;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#000000";
        for (let row = 0; row < moduleCount; row++) {
          for (let col = 0; col < moduleCount; col++) {
            if (qr.isDark(row, col))
              ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
          }
        }
```

ersetzen durch:

```js
        renderQrToCanvas(code, document.getElementById("qr-canvas"));
```

- [ ] **Step 4: Zahlungs-Gate in `loadQrCode` einbauen**

In `loadQrCode`, direkt nach der Zeile `const registration = qrRegistrations.find(...)` und dem zugehörigen `if (!registration) { ... return; }`-Block, vor dem `const code = buildScanCode(...)`-Aufruf, einfügen:

```js
        applyPaymentGate(activeEvent.id, registration);
```

Und die Funktion `applyPaymentGate` direkt nach `renderQrToCanvas` ergänzen:

```js
    function formatEuro(cents) {
      return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
    }

    function applyPaymentGate(eventId, registration) {
      const gated = registration.amountDueCents != null && !registration.paidAt;
      document.getElementById("ticket-download-png").disabled = gated;
      document.getElementById("ticket-download-pdf").disabled = gated;
      const hint = document.getElementById("ticket-payment-hint");
      const payButton = document.getElementById("ticket-pay-btn");
      hint.style.display = gated ? "" : "none";
      payButton.style.display = gated ? "" : "none";
      if (gated) {
        hint.textContent = `Zahlung offen: ${formatEuro(registration.amountDueCents)}`;
        payButton.onclick = () => openPaymentDialog(eventId, registration);
      }
    }
```

- [ ] **Step 5: Zahlungs-Dialog-Logik ergänzen**

Nach `applyPaymentGate` einfügen:

```js
    const paymentDialog = document.getElementById("payment-dialog");
    let payingEventId = null;
    let payingRegistration = null;

    function openPaymentDialog(eventId, registration) {
      payingEventId = eventId;
      payingRegistration = registration;
      document.getElementById("payment-dialog-amount").textContent = formatEuro(registration.amountDueCents);
      document.getElementById("payment-bank-info").style.display = "none";
      document.getElementById("payment-girocode-wrap").style.display = "none";
      paymentDialog.showModal();
    }

    async function startCheckout(method) {
      try {
        const { url } = await api.post(
          `/events/${payingEventId}/registrations/${currentUserId}/checkout-session`,
          { method },
        );
        window.location.href = url;
      } catch (err) {
        notify(err.message, "error");
      }
    }

    document.getElementById("payment-paypal-btn").addEventListener("click", () => startCheckout("paypal"));
    document.getElementById("payment-card-btn").addEventListener("click", () => startCheckout("card"));

    document.getElementById("payment-bank-btn").addEventListener("click", async () => {
      try {
        const settings = await api.get("/payment-settings");
        document.getElementById("payment-bank-iban").textContent = settings.bankIban ?? "–";
        document.getElementById("payment-bank-bic").textContent = settings.bankBic ?? "–";
        document.getElementById("payment-bank-holder").textContent = settings.bankAccountHolder ?? "–";
        document.getElementById("payment-bank-reference").textContent = payingRegistration.paymentReference;
        document.getElementById("payment-bank-info").style.display = "";
      } catch (err) {
        notify(err.message, "error");
      }
    });

    document.getElementById("payment-girocode-btn").addEventListener("click", async () => {
      try {
        const settings = await api.get("/payment-settings");
        const payload = buildEpcQrPayload({
          iban: settings.bankIban,
          bic: settings.bankBic,
          name: settings.bankAccountHolder,
          amountCents: payingRegistration.amountDueCents,
          reference: payingRegistration.paymentReference,
        });
        renderQrToCanvas(payload, document.getElementById("payment-girocode-canvas"));
        document.getElementById("payment-girocode-wrap").style.display = "";
      } catch (err) {
        notify(err.message, "error");
      }
    });

    document.getElementById("payment-dialog-close").addEventListener("click", () => paymentDialog.close());
```

- [ ] **Step 6: Manuell prüfen**

Als Teilnehmer einloggen, Admin setzt vorher (Task 11) einen Betrag für diese Registrierung. Dashboard neu laden → Ticket-Download-Buttons ausgegraut, "Zahlung offen: X,XX €" sichtbar, "Jetzt zahlen" öffnet den Dialog mit Betrag; "Überweisungsinformationen anzeigen" zeigt IBAN/BIC/Referenz; "Girocode anzeigen" rendert einen QR-Code (mit einer beliebigen Banking-App oder einem Online-EPC-QR-Decoder gegenprüfen, dass die Felder stimmen). "Per PayPal"/"Per Kreditkarte" mit gültigen Stripe-Testkeys hinterlegt → Weiterleitung zur Stripe-Checkout-Seite.

- [ ] **Step 7: Commit**

```bash
git add frontend/account.html
git commit -m "feat: gate ticket downloads on payment status, add payment dialog with 4 methods"
```

---

### Task 13: Vollständiger Testlauf

**Files:** keine (Verifikation)

- [ ] **Step 1: Kompletten Testlauf ausführen**

Run: `npm test`
Expected: Alle Tests PASS (bestehende + alle in Task 1-9 hinzugefügten), Exit-Code 0.

- [ ] **Step 2: Bei Fehlschlägen beheben**

Jeden Fehlschlag einzeln untersuchen und beheben (nicht pauschal Tests anpassen, um sie grün zu bekommen) — insbesondere auf Seiteneffekte der Schema-Erweiterung in Task 9 auf andere, nicht direkt geänderte Tests achten (z.B. Snapshot-artige Assertions auf die vollständige Objektform von `listParticipantsForEvent`/`listRegistrationsForUser` in anderen Testdateien).

- [ ] **Step 3: Abschluss-Commit, falls Fixes nötig waren**

```bash
git add -A
git commit -m "fix: address test failures from full suite run"
```

(Falls Step 1 bereits ohne Änderungen grün war, entfällt dieser Commit.)
