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
