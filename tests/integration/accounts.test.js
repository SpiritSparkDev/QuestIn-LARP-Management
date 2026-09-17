import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { seedNscProfileSchema } = await import('../../db/seedNscProfileSchema.js');
await seedNscProfileSchema();

const { createServer } = await import('../../backend/server.js');
await import('../../backend/auth/register.js');
await import('../../backend/auth/login.js');
await import('../../backend/accounts/routes.js');
const { query, closePool } = await import('../../backend/db.js');

async function registerLoginAndGetCookie(port) {
  const email = `account-${crypto.randomUUID()}@example.com`;
  const password = 'correct horse battery staple';

  const registerRes = await fetch(`http://localhost:${port}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, firstName: 'Account', lastName: 'Test' }),
  });
  const { id } = await registerRes.json();
  const { rows } = await query('SELECT token FROM email_verification_tokens WHERE user_id = $1', [id]);
  await fetch(`http://localhost:${port}/auth/verify?token=${rows[0].token}`);

  const loginRes = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { userId: id, cookie: loginRes.headers.get('set-cookie').split(';')[0] };
}

test('GET /account requires authentication', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/account`);
    assert.equal(res.status, 401);
  });
});

test('GET /account returns the logged-in user\'s account with null sensitive fields initially', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await registerLoginAndGetCookie(port);

    const res = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Account Test');
    assert.equal(body.address, null);
    assert.deepEqual(body.group, { key: 'mitglied', name: 'Mitglied' });
    assert.ok(Array.isArray(body.menus));
    assert.equal(body.canEditCharacters, false);
  });
});

test('GET /account exposes discordUsername only when a discord account is linked', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await registerLoginAndGetCookie(port);

    const before = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    assert.equal((await before.json()).discordUsername, null);

    await query(
      "INSERT INTO oauth_accounts (user_id, provider, provider_user_id, username) VALUES ($1, 'discord', $2, 'somebody')",
      [userId, `discord-${crypto.randomUUID()}`]
    );

    const after = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    assert.equal((await after.json()).discordUsername, 'somebody');
  });
});

test('PATCH /account encrypts and returns sensitive fields; unspecified fields survive a partial update', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await registerLoginAndGetCookie(port);

    const patchRes = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        address: 'Musterstraße 1, 12345 Musterstadt',
        phone: '+49 123 456789',
        emergencyContactLastName: 'Mustermann',
        emergencyContactFirstName: 'Erika',
        emergencyContactPhone: '+49 987 654321',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.address, 'Musterstraße 1, 12345 Musterstadt');
    assert.equal(patched.phone, '+49 123 456789');
    assert.equal(patched.name, 'Account Test');
    assert.equal(patched.emergencyContactLastName, 'Mustermann');
    assert.equal(patched.emergencyContactFirstName, 'Erika');
    assert.equal(patched.emergencyContactPhone, '+49 987 654321');

    const { rows } = await query('SELECT address_enc, emergency_contact_last_name_enc FROM users WHERE id = $1', [userId]);
    assert.notEqual(rows[0].address_enc.toString('utf8'), 'Musterstraße 1, 12345 Musterstadt');
    assert.notEqual(rows[0].emergency_contact_last_name_enc.toString('utf8'), 'Mustermann');

    const secondPatchRes = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ medicalNotes: 'keine' }),
    });
    const secondPatched = await secondPatchRes.json();
    assert.equal(secondPatched.address, 'Musterstraße 1, 12345 Musterstadt');
    assert.equal(secondPatched.medicalNotes, 'keine');
  });
});

test('PATCH /account silently ignores an nscData field (no longer a recognized account field)', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await registerLoginAndGetCookie(port);
    const res = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ firstName: 'Still', lastName: 'Works', nscData: { anything: 'ignored' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Still Works');
    assert.equal(body.nscData, undefined);
  } finally {
    server.close();
  }
});

test('GET /account includes canOverrideCheckinStatus from the caller\'s group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await registerLoginAndGetCookie(port);
    const res = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    const body = await res.json();
    assert.equal(body.canOverrideCheckinStatus, false);
  } finally {
    server.close();
  }
});

test('PATCH /account saves and returns hotkeys; GET /account defaults to an empty object', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await registerLoginAndGetCookie(port);

    const beforeRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    assert.deepEqual((await beforeRes.json()).hotkeys, {});

    const patchRes = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ hotkeys: { confirm: 'Enter', cancel: 'Escape', scan: ' ' } }),
    });
    assert.equal(patchRes.status, 200);
    assert.deepEqual((await patchRes.json()).hotkeys, { confirm: 'Enter', cancel: 'Escape', scan: ' ' });

    const afterRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: cookie } });
    assert.deepEqual((await afterRes.json()).hotkeys, { confirm: 'Enter', cancel: 'Escape', scan: ' ' });
  });
});

test('PATCH /account omitting hotkeys preserves the previously-saved value', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await registerLoginAndGetCookie(port);

    await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ hotkeys: { confirm: 'k' } }),
    });

    const secondPatchRes = await fetch(`http://localhost:${port}/account`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ nickname: 'Unrelated Change' }),
    });
    const secondPatched = await secondPatchRes.json();
    assert.equal(secondPatched.nickname, 'Unrelated Change');
    assert.deepEqual(secondPatched.hotkeys, { confirm: 'k' });
  });
});

test.after(async () => {
  await closePool();
});
