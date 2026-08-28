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

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Groups Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`groups-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /groups rejects a non-admin group', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/groups`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('GET /groups returns all 8 seeded groups for an admin', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const groups = await res.json();
    const keys = groups.map((g) => g.key);
    const defaultKeys = ['admin', 'orga', 'plot_orga', 'sl', 'hilfs_sl', 'nsc', 'gsc', 'sc'];
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

test('POST /groups accepts and returns characterClasses; PUT /groups/:id updates them', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ key: `test_class_${crypto.randomUUID().slice(0, 8)}`, name: 'Class Test', characterClasses: ['sc'] }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.deepEqual(created.character_classes, ['sc']);

    const updateRes = await fetch(`http://localhost:${port}/groups/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ characterClasses: ['sc', 'nsc'] }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.deepEqual(updated.character_classes, ['sc', 'nsc']);

    await query('DELETE FROM groups WHERE id = $1', [created.id]);
  } finally {
    server.close();
  }
});

test('POST /groups rejects an invalid characterClasses value', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const admin = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ key: `test_bad_class_${crypto.randomUUID().slice(0, 8)}`, name: 'Bad Class Test', characterClasses: ['wizard'] }),
    });
    assert.equal(res.status, 400);
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

test.after(async () => {
  await query("DELETE FROM groups WHERE key ~ '^(custom|dup|editable|renamed)_[0-9]+$'");
  await closePool();
});
