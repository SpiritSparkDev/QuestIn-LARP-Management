import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');
const { createServer } = await import('../../backend/server.js');
const { getSmtpSettingsForSending } = await import('../../backend/smtpSettings/repository.js');

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'SMTP', 'Settings Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`smtp-settings-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('PUT then GET /admin/settings/smtp never returns a plaintext password, only hasPassword', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');

    const putRes = await fetch(`http://localhost:${port}/admin/settings/smtp`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        host: 'smtp.example.com', port: 587, username: 'bot@example.com',
        password: 'super-secret', fromAddress: 'no-reply@example.com',
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.hasPassword, true);
    assert.ok(!('password' in putBody));
    assert.ok(!JSON.stringify(putBody).includes('super-secret'));

    const getRes = await fetch(`http://localhost:${port}/admin/settings/smtp`, { headers: { Cookie: cookie } });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.hasPassword, true);
    assert.ok(!('password' in getBody));
    assert.ok(!JSON.stringify(getBody).includes('super-secret'));
  } finally {
    server.close();
  }
});

test('PUT /admin/settings/smtp with an omitted password preserves the previously-saved password', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');

    await fetch(`http://localhost:${port}/admin/settings/smtp`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        host: 'smtp.example.com', port: 587, username: 'bot@example.com',
        password: 'keep-me-secret', fromAddress: 'no-reply@example.com',
      }),
    });

    // Second update: no password field at all, but a different host — must
    // NOT wipe the previously-set password (the COALESCE pattern in
    // repository.js's setSmtpSettings).
    const secondPut = await fetch(`http://localhost:${port}/admin/settings/smtp`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ host: 'smtp2.example.com', port: 2525, username: 'bot@example.com', fromAddress: 'no-reply@example.com' }),
    });
    assert.equal(secondPut.status, 200);
    const secondBody = await secondPut.json();
    assert.equal(secondBody.host, 'smtp2.example.com');
    assert.equal(secondBody.hasPassword, true);

    // The public API deliberately never returns the plaintext password, so
    // verify the preserve behavior directly against the same internal,
    // decrypting accessor backend/auth/mailer.js itself uses.
    const forSending = await getSmtpSettingsForSending();
    assert.equal(forSending.password, 'keep-me-secret');
    assert.equal(forSending.host, 'smtp2.example.com');
  } finally {
    server.close();
  }
});

test('GET/PUT/POST .../test on /admin/settings/smtp all reject a non-admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');

    const getRes = await fetch(`http://localhost:${port}/admin/settings/smtp`, { headers: { Cookie: cookie } });
    assert.equal(getRes.status, 403);

    const putRes = await fetch(`http://localhost:${port}/admin/settings/smtp`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ host: 'smtp.example.com' }),
    });
    assert.equal(putRes.status, 403);

    const testRes = await fetch(`http://localhost:${port}/admin/settings/smtp/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ host: 'smtp.example.com', to: 'someone@example.com' }),
    });
    assert.equal(testRes.status, 403);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'smtp-settings-%'");
  await query('DELETE FROM smtp_settings');
  await closePool();
});
