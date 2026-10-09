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
    assert.deepEqual(body, { bankIban: 'DE02100100100006820101', bankBic: 'PBNKDEFF', bankAccountHolder: 'Pakyrion e.V.', bankQrEnabled: true, contactEmail: null, stripeMethods: ['card', 'paypal', 'bank_transfer'], sumupEnabled: false, paypalEnabled: false });
    await fetch(`http://localhost:${port}/admin/settings/payments`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ bankQrEnabled: false }),
    });
    const off = await (await fetch(`http://localhost:${port}/payment-settings`, { headers: { Cookie: memberCookie } })).json();
    assert.equal(off.bankQrEnabled, false);
    assert.equal(off.bankIban, 'DE02100100100006820101');
  } finally {
    server.close();
  }
});

test('PayPal credentials: secret is never returned, paypalEnabled needs both; Stripe methods are validated and filtered', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const { cookie: memberCookie } = await makeUserAndSession('mitglied');
    const put = (body) => fetch(`http://localhost:${port}/admin/settings/payments`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(body),
    });
    const shown = async () => (await fetch(`http://localhost:${port}/payment-settings`, { headers: { Cookie: memberCookie } })).json();

    assert.equal((await put({ stripeMethods: ['card', 'bitcoin'] })).status, 400);
    assert.equal((await put({ paypalSandbox: 'yes' })).status, 400);
    assert.equal((await put({ contactEmail: 'kein mail' })).status, 400);
    assert.equal((await put({ contactEmail: 'orga@example.com' })).status, 200);
    assert.equal((await shown()).contactEmail, 'orga@example.com');
    assert.equal((await put({ contactEmail: '' })).status, 200);
    assert.equal((await shown()).contactEmail, null);

    assert.equal((await put({ paypalClientId: 'client-id-1' })).status, 200);
    assert.equal((await shown()).paypalEnabled, false); // secret still missing
    const saved = await (await put({ paypalSecret: 'paypal-secret-never-leak', paypalSandbox: true })).json();
    assert.equal(saved.hasPaypalSecret, true);
    assert.equal(saved.paypalSandbox, true);
    assert.ok(!JSON.stringify(saved).includes('paypal-secret-never-leak'));
    const forMember = await shown();
    assert.equal(forMember.paypalEnabled, true);
    assert.ok(!JSON.stringify(forMember).includes('paypal-secret-never-leak'));
    assert.ok(!JSON.stringify(forMember).includes('client-id-1'));

    await put({ stripeSecretKey: 'sk_methods_test' });
    assert.equal((await put({ stripeMethods: ['klarna', 'sepa_debit'] })).status, 200);
    assert.deepEqual((await shown()).stripeMethods, ['klarna', 'sepa_debit']);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'payment-settings-%'");
  await query('DELETE FROM payment_settings');
  await closePool();
});
