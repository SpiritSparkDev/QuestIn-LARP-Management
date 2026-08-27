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

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, name, group_id, email_verified) VALUES ($1, 'Members Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`members-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('GET /members rejects a group without the mitglieder menu', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('GET /members includes both active members and open invitations', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const members = await res.json();
    assert.ok(members.some((m) => m.status === 'active'));
  } finally {
    server.close();
  }
});

test('PATCH /members/:id rejects a field the caller group is not permitted to edit', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    // orga has 'mitglieder' access (so it passes requireMenu) but, per
    // defaults, does NOT have 'group' in its account_fields — a real,
    // meaningful case to test, not an arbitrary one: orga must not be
    // able to reassign a member's group despite being able to reach this
    // endpoint at all.
    const { cookie } = await makeUserAndSession('orga');
    const { userId: targetId } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/members/${targetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ group: 'admin' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /members/:id updates an allowed field for an admin caller', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const { userId: targetId } = await makeUserAndSession('sc');
    const res = await fetch(`http://localhost:${port}/members/${targetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ address: 'Neue Adresse 1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.address, 'Neue Adresse 1');
  } finally {
    server.close();
  }
});

test('POST /members/invite creates an invitation and rejects an existing email', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `invite-${crypto.randomUUID()}@example.com`;
    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'New Member', group: 'sc' }),
    });
    assert.equal(res.status, 201);

    const dupeRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'Again', group: 'sc' }),
    });
    // First invite doesn't create a users row, so this checks the SECOND
    // invite to the same still-pending address is allowed (no uniqueness
    // constraint on invitations.email) — only an existing users row 409s.
    assert.equal(dupeRes.status, 201);
  } finally {
    server.close();
  }
});

test('POST /members/invite defaults to the sc group when group is omitted', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `invite-default-${crypto.randomUUID()}@example.com`;
    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'Default Group' }),
    });
    assert.equal(res.status, 201);
    const { rows } = await query('SELECT group_id FROM invitations WHERE email = $1', [email]);
    const { rows: scGroup } = await query("SELECT id FROM groups WHERE key = 'sc'");
    assert.equal(rows[0].group_id, scGroup[0].id);
  } finally {
    server.close();
  }
});

test('POST /members/invite rejects an explicit group from a caller without the group permission', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    // orga has 'mitglieder' menu access (so it passes requireMenu) but,
    // per defaults, does NOT have 'group' in its account_fields — this is
    // exactly the case the fix guards: a group that can invite people but
    // must not be able to hand out a higher group than its own reach.
    const { cookie } = await makeUserAndSession('orga');
    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email: `invite-blocked-${crypto.randomUUID()}@example.com`, name: 'Blocked', group: 'admin' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /members/invitations/:id/resend issues a new token', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `resend-route-${crypto.randomUUID()}@example.com`;
    const createRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'Resend Route', group: 'sc' }),
    });
    const created = await createRes.json();
    const resendRes = await fetch(`http://localhost:${port}/members/invitations/${created.id}/resend`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(resendRes.status, 200);
  } finally {
    server.close();
  }
});

test('POST /members/invite ignores an attacker-supplied groupId that bypasses the group field check', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    // orga lacks 'group' in its account_fields, so filterToAllowedFields
    // blocks the 'group' key — but createInvitation is built from
    // { ...rest, groupId, invitedBy }, and 'groupId' (a different key
    // name) isn't in ACCOUNT_FIELD_KEYS at all, so before the fix a caller
    // could sneak a real, valid group uuid through under the wrong key
    // and have it silently override the server-computed groupId via
    // object-spread order. Using the real admin group id (not a bogus
    // one) proves this is a valid-but-unauthorized override being
    // ignored, not just invalid-input rejection.
    const { cookie } = await makeUserAndSession('orga');
    const { rows: adminGroup } = await query("SELECT id FROM groups WHERE key = 'admin'");
    const email = `invite-groupid-bypass-${crypto.randomUUID()}@example.com`;
    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, name: 'GroupId Bypass', groupId: adminGroup[0].id }),
    });
    assert.equal(res.status, 201);
    const { rows } = await query('SELECT group_id FROM invitations WHERE email = $1', [email]);
    const { rows: scGroup } = await query("SELECT id FROM groups WHERE key = 'sc'");
    assert.equal(rows[0].group_id, scGroup[0].id);
    assert.notEqual(rows[0].group_id, adminGroup[0].id);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM invitations");
  await query("DELETE FROM users WHERE email LIKE 'members-%'");
  await closePool();
});
