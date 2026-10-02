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

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey, { firstName = 'Email', lastName = 'Templates Test' } = {}) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, $2, $3, (SELECT id FROM groups WHERE key = $4), true) RETURNING id",
    [`email-templates-${groupKey}-${crypto.randomUUID()}@example.com`, firstName, lastName, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function createCharacterFor(userId, name) {
  const { rows } = await query(
    "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', $2, '{}') RETURNING id",
    [userId, name]
  );
  return rows[0].id;
}

test('/admin/email-templates CRUD rejects non-admin callers', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };

    assert.equal((await fetch(`http://localhost:${port}/admin/email-templates`, { headers })).status, 403);
    assert.equal((await fetch(`http://localhost:${port}/admin/email-templates/fields`, { headers })).status, 403);
    assert.equal((await fetch(`http://localhost:${port}/admin/email-templates`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'x' }),
    })).status, 403);
  });
});

test('/admin/email-templates CRUD round-trip for an admin', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };

    const createRes = await fetch(`http://localhost:${port}/admin/email-templates`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Willkommen', subject: 'Hallo {{account.firstName}}', body: 'Text', isHtml: false }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.name, 'Willkommen');
    assert.equal(created.isHtml, false);

    const listRes = await fetch(`http://localhost:${port}/admin/email-templates`, { headers });
    const list = await listRes.json();
    assert.ok(list.some((t) => t.id === created.id));

    const putRes = await fetch(`http://localhost:${port}/admin/email-templates/${created.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ name: 'Willkommen v2', subject: created.subject, body: created.body, isHtml: true }),
    });
    assert.equal(putRes.status, 200);
    assert.equal((await putRes.json()).isHtml, true);

    const deleteRes = await fetch(`http://localhost:${port}/admin/email-templates/${created.id}`, { method: 'DELETE', headers });
    assert.equal(deleteRes.status, 200);

    const getAfterDelete = await fetch(`http://localhost:${port}/admin/email-templates/${created.id}`, { headers });
    assert.equal(getAfterDelete.status, 404);
  });
});

test('POST /admin/email-templates rejects an invalid payload', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const res = await fetch(`http://localhost:${port}/admin/email-templates`, {
      method: 'POST', headers, body: JSON.stringify({ name: '' }),
    });
    assert.equal(res.status, 400);
  });
});

test('GET /admin/email-templates/fields includes the built-in OT and IT fields', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/admin/email-templates/fields`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const fields = await res.json();
    assert.ok(fields.account.some((f) => f.key === 'firstName'));
    assert.ok(fields.account.some((f) => f.key === 'email'));
    assert.ok(fields.character.some((f) => f.key === 'name'));
  });
});

test('POST /admin/email-templates/:id/preview merges OT and IT fields and respects isHtml escaping', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const { userId: targetUserId } = await makeUserAndSession('mitglied', { firstName: 'A&B', lastName: 'Tester' });
    const characterId = await createCharacterFor(targetUserId, 'Held <der> Lande');

    const plainTemplate = await (await fetch(`http://localhost:${port}/admin/email-templates`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Plain', subject: 'Hi {{account.firstName}}', body: 'Dein Charakter: {{character.name}}', isHtml: false }),
    })).json();

    const plainPreview = await (await fetch(`http://localhost:${port}/admin/email-templates/${plainTemplate.id}/preview`, {
      method: 'POST', headers, body: JSON.stringify({ userId: targetUserId, characterId }),
    })).json();
    assert.equal(plainPreview.subject, 'Hi A&B');
    assert.equal(plainPreview.body, 'Dein Charakter: Held <der> Lande');

    const htmlTemplate = await (await fetch(`http://localhost:${port}/admin/email-templates`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'HTML', subject: 'Hi', body: '<p>{{character.name}}</p>', isHtml: true }),
    })).json();
    const htmlPreview = await (await fetch(`http://localhost:${port}/admin/email-templates/${htmlTemplate.id}/preview`, {
      method: 'POST', headers, body: JSON.stringify({ userId: targetUserId, characterId }),
    })).json();
    // HTML mode must escape a field value containing markup characters.
    assert.ok(htmlPreview.body.includes('&lt;der&gt;'));
  });
});

test('POST /admin/email-templates/:id/preview rejects a character that does not belong to the given member', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const { userId: userA } = await makeUserAndSession('mitglied');
    const { userId: userB } = await makeUserAndSession('mitglied');
    const characterOfB = await createCharacterFor(userB, 'Fremder Charakter');

    const template = await (await fetch(`http://localhost:${port}/admin/email-templates`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'X', subject: 'S', body: 'B', isHtml: false }),
    })).json();

    const res = await fetch(`http://localhost:${port}/admin/email-templates/${template.id}/preview`, {
      method: 'POST', headers, body: JSON.stringify({ userId: userA, characterId: characterOfB }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /admin/email-templates/:id/send-test sends via the (jsonTransport) fallback transporter', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const { userId: targetUserId } = await makeUserAndSession('mitglied', { firstName: 'Sendetest' });

    const template = await (await fetch(`http://localhost:${port}/admin/email-templates`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Send', subject: 'Betreff {{account.firstName}}', body: 'Body', isHtml: false }),
    })).json();

    const res = await fetch(`http://localhost:${port}/admin/email-templates/${template.id}/send-test`, {
      method: 'POST', headers, body: JSON.stringify({ userId: targetUserId }),
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.sent, true);
    assert.equal(result.subject, 'Betreff Sendetest');
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'email-templates-%'");
  await query('DELETE FROM email_templates');
  await closePool();
});
