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

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Groups', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`groups-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /groups rejects a non-admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('mitglied');
    const res = await fetch(`http://localhost:${port}/groups`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('GET /groups returns all 3 seeded groups for an admin', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const groups = await res.json();
    const keys = groups.map((g) => g.key);
    const defaultKeys = ['admin', 'moderator', 'mitglied'];
    for (const key of defaultKeys) {
      assert.ok(keys.includes(key), `missing default group: ${key}`);
    }
  } finally {
    server.close();
  }
});

test('POST /groups creates a new custom group with no permissions by default', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `custom_${Date.now()}`, name: 'Custom Group' }),
    });
    assert.equal(res.status, 201);
    const group = await res.json();
    assert.deepEqual(group.visible_menus, []);
    assert.deepEqual(group.account_fields, []);
    assert.equal(group.can_edit_characters, false);
    assert.equal(group.is_protected, false);
  } finally {
    server.close();
  }
});

test('POST /groups rejects a duplicate key', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const key = `dup_${Date.now()}`;
    await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key, name: 'First' }),
    });
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key, name: 'Second' }),
    });
    assert.equal(res.status, 409);
  } finally {
    server.close();
  }
});

test('POST /groups accepts a newly-admin-added account-schema field key in accountFields', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const schemaRes = await fetch(`http://localhost:${port}/account-schema`, { headers: { Cookie: cookie } });
    const originalSchema = await schemaRes.json();
    const newSchema = [...originalSchema, { key: 'newTestField', label: 'Neues Testfeld', type: 'text', required: false }];
    try {
      await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: newSchema }),
      });

      const res = await fetch(`http://localhost:${port}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ key: `test_group_${crypto.randomUUID().slice(0, 8)}`, name: 'Test Group', accountFields: ['newTestField'] }),
      });
      assert.equal(res.status, 201);
    } finally {
      await fetch(`http://localhost:${port}/account-schema`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ schema: originalSchema }),
      });
    }
  } finally {
    server.close();
  }
});

test('POST /groups rejects an invalid menu key', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `bad_${Date.now()}`, name: 'Bad', visibleMenus: ['not_a_real_menu'] }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /groups rejects the retired charaktere/con-anmeldungen menu keys', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `retired_${Date.now()}`, name: 'Retired', visibleMenus: ['charaktere'] }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PUT /groups/:id updates a non-protected group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `editable_${Date.now()}`, name: 'Editable' }),
    });
    const created = await createRes.json();
    const putRes = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ visibleMenus: ['konto', 'checkin'], canEditCharacters: true }),
    });
    assert.equal(putRes.status, 200);
    const updated = await putRes.json();
    assert.deepEqual(updated.visible_menus.sort(), ['checkin', 'konto']);
    assert.equal(updated.can_edit_characters, true);
  } finally {
    server.close();
  }
});

test('PUT /groups/:id updates the group name', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `renamed_${Date.now()}`, name: 'Before Rename' }),
    });
    const created = await createRes.json();
    const putRes = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'After Rename' }),
    });
    assert.equal(putRes.status, 200);
    const updated = await putRes.json();
    assert.equal(updated.name, 'After Rename');

    const listRes = await fetch(`http://localhost:${port}/groups`, { headers: { Cookie: cookie } });
    const groups = await listRes.json();
    const found = groups.find((g) => g.id === created.id);
    assert.equal(found.name, 'After Rename');
  } finally {
    server.close();
  }
});

test('PUT /groups/:id rejects editing the protected admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const { rows } = await query("SELECT id FROM groups WHERE key = 'admin'");
    const res = await fetch(`http://localhost:${port}/groups/${rows[0].id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ visibleMenus: [] }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('POST /groups accepts and returns canOverrideCheckinStatus; PUT /groups/:id updates it', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ key: `test_override_${crypto.randomUUID().slice(0, 8)}`, name: 'Override Test', canOverrideCheckinStatus: true }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.can_override_checkin_status, true);

    const updateRes = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ canOverrideCheckinStatus: false }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal((await updateRes.json()).can_override_checkin_status, false);

    await query('DELETE FROM groups WHERE id = $1', [created.id]);
  } finally {
    server.close();
  }
});

test('DELETE /groups/:id removes an unused, non-protected group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `deletable_${Date.now()}`, name: 'Deletable' }),
    });
    const created = await createRes.json();

    const deleteRes = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(deleteRes.status, 200);

    const { rows } = await query('SELECT id FROM groups WHERE id = $1', [created.id]);
    assert.equal(rows.length, 0);
  } finally {
    server.close();
  }
});

test('DELETE /groups/:id rejects deleting the protected admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const { rows } = await query("SELECT id FROM groups WHERE key = 'admin'");
    const res = await fetch(`http://localhost:${port}/groups/${rows[0].id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('DELETE /groups/:id returns 409 when a member still belongs to the group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ key: `inuse_${Date.now()}`, name: 'In Use' }),
    });
    const created = await createRes.json();
    await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'InUse', 'Test', $2, true)",
      [`groups-inuse-${crypto.randomUUID()}@example.com`, created.id]
    );

    const res = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 409);

    await query('DELETE FROM users WHERE group_id = $1', [created.id]);
    await query('DELETE FROM groups WHERE id = $1', [created.id]);
  } finally {
    server.close();
  }
});

test('DELETE /groups/:id returns 404 for an unknown group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups/${crypto.randomUUID()}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM groups WHERE key ~ '^(custom|dup|editable|renamed|deletable|inuse)_[0-9]+$' OR key ~ '^test_group_[0-9a-f]+$'");
  await closePool();
});
