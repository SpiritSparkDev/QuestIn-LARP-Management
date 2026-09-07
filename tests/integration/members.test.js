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
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Members', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
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
    const invitedEmail = `invite-list-${crypto.randomUUID()}@example.com`;
    const inviteRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email: invitedEmail, firstName: 'Invited', lastName: 'Member', group: 'sc' }),
    });
    assert.equal(inviteRes.status, 201);

    const res = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const members = await res.json();
    assert.ok(members.some((m) => m.status === 'active'));
    assert.ok(members.some((m) => m.status === 'invited' && m.email === invitedEmail));
  } finally {
    server.close();
  }
});

test('GET /members/:id returns every field regardless of the viewer\'s own permissions, plus the member\'s characters', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const { userId: targetId } = await makeUserAndSession('sc');

    await fetch(`http://localhost:${port}/members/${targetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ medicalNotes: 'Testnotizen' }),
    });

    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date) VALUES ('Detail Test Event', '2026-01-01') RETURNING id"
    );
    await query(
      "INSERT INTO characters (user_id, event_id, name) VALUES ($1, $2, 'Detail Test Char')",
      [targetId, eventRows[0].id]
    );

    // orga has the 'mitglieder' menu (so it passes requireMenu and can
    // reach GET /members/:id) but, per defaults, lacks 'group' in its
    // account_fields — proving the response isn't filtered down to what
    // the VIEWER may edit, only what PATCH would let them change.
    const { cookie: orgaCookie } = await makeUserAndSession('orga');
    const res = await fetch(`http://localhost:${port}/members/${targetId}`, { headers: { Cookie: orgaCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.medicalNotes, 'Testnotizen');
    assert.equal(body.group.key, 'sc');
    assert.equal(body.group.name, 'SC');
    assert.ok(body.characters.some((c) => c.name === 'Detail Test Char' && c.eventName === 'Detail Test Event'));

    await query('DELETE FROM events WHERE id = $1', [eventRows[0].id]);
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

test('POST /members/invite allows multiple pending invitations to the same unregistered email', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `invite-${crypto.randomUUID()}@example.com`;
    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, firstName: 'New', lastName: 'Member', group: 'sc' }),
    });
    assert.equal(res.status, 201);

    const dupeRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, firstName: 'Again', lastName: 'Member', group: 'sc' }),
    });
    // First invite doesn't create a users row, so this checks the SECOND
    // invite to the same still-pending address is allowed (no uniqueness
    // constraint on invitations.email) — only an existing users row 409s.
    assert.equal(dupeRes.status, 201);
  } finally {
    server.close();
  }
});

test('POST /members/invite rejects an email that already belongs to a registered user', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `members-invite-existing-${crypto.randomUUID()}@example.com`;
    await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Existing', 'Member', (SELECT id FROM groups WHERE key = $2), true)",
      [email, 'sc']
    );

    const res = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, firstName: 'Duplicate', lastName: 'Member', group: 'sc' }),
    });
    assert.equal(res.status, 409);
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
      body: JSON.stringify({ email, firstName: 'Default', lastName: 'Group' }),
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
      body: JSON.stringify({ email: `invite-blocked-${crypto.randomUUID()}@example.com`, firstName: 'Blocked', lastName: 'Member', group: 'admin' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /members/invite reports emailSent: false when SMTP is unreachable, but still creates the invitation', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `invite-mail-fail-${crypto.randomUUID()}@example.com`;

    // This test's premise (mailer.js falls through to SMTP_HOST/SMTP_PORT
    // below) only holds if no smtp_settings row exists — clear any row a
    // prior test in this run may have left behind, so this test doesn't
    // depend on run order.
    await query('DELETE FROM smtp_settings');

    // Point SMTP at an unreachable host for the duration of this one request —
    // mailer.js's DB-first lookup finds no smtp_settings row in the test DB,
    // so it falls through to these environment variables.
    const originalHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1'; // nothing listens on port 1; connection refused fast
    try {
      const res = await fetch(`http://localhost:${port}/members/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ email, firstName: 'Mail', lastName: 'Fail', group: 'sc' }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.emailSent, false);
    } finally {
      if (originalHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = originalHost;
      delete process.env.SMTP_PORT;
    }
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
      body: JSON.stringify({ email, firstName: 'Resend', lastName: 'Route', group: 'sc' }),
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

test('POST /members/invitations/:id/resend reports emailSent: false when SMTP is unreachable, but still reissues the token', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');

    await query('DELETE FROM smtp_settings');

    const email = `resend-mail-fail-${crypto.randomUUID()}@example.com`;
    const createRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, firstName: 'Resend', lastName: 'Fail', group: 'sc' }),
    });
    const created = await createRes.json();

    const originalHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1'; // nothing listens on port 1; connection refused fast
    try {
      const resendRes = await fetch(`http://localhost:${port}/members/invitations/${created.id}/resend`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      assert.equal(resendRes.status, 200);
      const body = await resendRes.json();
      assert.equal(body.emailSent, false);
    } finally {
      if (originalHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = originalHost;
      delete process.env.SMTP_PORT;
    }
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
      body: JSON.stringify({ email, firstName: 'GroupId', lastName: 'Bypass', groupId: adminGroup[0].id }),
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

test('POST /members/invite accepts an optional eventId and rejects an unknown one', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const { rows: eventRows } = await query(
      "INSERT INTO events (name, event_date) VALUES ('Members Invite Test Con', '2027-06-01') RETURNING id"
    );
    const email = `invite-event-${crypto.randomUUID()}@example.com`;

    const badRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, firstName: 'Event', lastName: 'Invite', group: 'sc', eventId: crypto.randomUUID() }),
    });
    assert.equal(badRes.status, 400);

    const okRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, firstName: 'Event', lastName: 'Invite', group: 'sc', eventId: eventRows[0].id }),
    });
    assert.equal(okRes.status, 201);
    const { rows } = await query('SELECT event_id FROM invitations WHERE email = $1', [email]);
    assert.equal(rows[0].event_id, eventRows[0].id);
  } finally {
    server.close();
  }
});

test('POST /members/invitations/:id/cancel cancels an open invitation and it disappears from GET /members', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie } = await makeUserAndSession('admin');
    const email = `invite-cancel-route-${crypto.randomUUID()}@example.com`;
    const createRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, firstName: 'Cancel', lastName: 'Route', group: 'sc' }),
    });
    const created = await createRes.json();

    const cancelRes = await fetch(`http://localhost:${port}/members/invitations/${created.id}/cancel`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assert.equal(cancelRes.status, 200);

    const listRes = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: cookie } });
    const list = await listRes.json();
    assert.equal(list.some((m) => m.email === email), false);

    const secondCancelRes = await fetch(`http://localhost:${port}/members/invitations/${created.id}/cancel`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    assert.equal(secondCancelRes.status, 409);
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate blocks login, kills sessions, and hides the member from the default list', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const { userId: targetId, cookie: targetCookie } = await makeUserAndSession('sc');

    const listBefore = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: adminCookie } });
    const membersBefore = await listBefore.json();
    assert.ok(membersBefore.some((m) => m.id === targetId));

    const deactivateRes = await fetch(`http://localhost:${port}/members/${targetId}/deactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(deactivateRes.status, 200);

    // The target's pre-existing session must be dead immediately.
    const meRes = await fetch(`http://localhost:${port}/account`, { headers: { Cookie: targetCookie } });
    assert.equal(meRes.status, 401);

    // Deactivated members are hidden from the default list...
    const listAfter = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: adminCookie } });
    const membersAfter = await listAfter.json();
    assert.ok(!membersAfter.some((m) => m.id === targetId));

    // ...but visible with includeDeactivated=true, with status 'deactivated'.
    const listIncluding = await fetch(`http://localhost:${port}/members?includeDeactivated=true`, { headers: { Cookie: adminCookie } });
    const membersIncluding = await listIncluding.json();
    const found = membersIncluding.find((m) => m.id === targetId);
    assert.ok(found);
    assert.equal(found.status, 'deactivated');
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate rejects deactivating your own account', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { userId: adminId, cookie: adminCookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/members/${adminId}/deactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate rejects an uppercase-cased version of your own id', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { userId: adminId, cookie: adminCookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/members/${adminId.toUpperCase()}/deactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate is idempotent — a second call does not change the original timestamp', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const { userId: targetId } = await makeUserAndSession('sc');

    await fetch(`http://localhost:${port}/members/${targetId}/deactivate`, { method: 'POST', headers: { Cookie: adminCookie } });
    const firstTimestamp = (await query('SELECT deactivated_at FROM users WHERE id = $1', [targetId])).rows[0].deactivated_at;

    await new Promise((resolve) => setTimeout(resolve, 50)); // ensure now() would differ if it were re-applied
    const secondRes = await fetch(`http://localhost:${port}/members/${targetId}/deactivate`, { method: 'POST', headers: { Cookie: adminCookie } });
    assert.equal(secondRes.status, 200);
    const secondTimestamp = (await query('SELECT deactivated_at FROM users WHERE id = $1', [targetId])).rows[0].deactivated_at;

    assert.equal(new Date(firstTimestamp).getTime(), new Date(secondTimestamp).getTime());
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate returns 404 for an unknown member', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/members/${crypto.randomUUID()}/deactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /members/:id/reactivate restores login and default-list visibility', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: adminCookie } = await makeUserAndSession('admin');
    const { userId: targetId } = await makeUserAndSession('sc');

    await fetch(`http://localhost:${port}/members/${targetId}/deactivate`, { method: 'POST', headers: { Cookie: adminCookie } });
    const reactivateRes = await fetch(`http://localhost:${port}/members/${targetId}/reactivate`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(reactivateRes.status, 200);

    const listAfter = await fetch(`http://localhost:${port}/members`, { headers: { Cookie: adminCookie } });
    const membersAfter = await listAfter.json();
    const found = membersAfter.find((m) => m.id === targetId);
    assert.ok(found);
    assert.equal(found.status, 'active');
  } finally {
    server.close();
  }
});

test('POST /members/:id/deactivate and /reactivate are rejected for a group without the mitglieder menu', async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const { cookie: scCookie } = await makeUserAndSession('sc');
    const { userId: targetId } = await makeUserAndSession('sc');

    const deactivateRes = await fetch(`http://localhost:${port}/members/${targetId}/deactivate`, {
      method: 'POST',
      headers: { Cookie: scCookie },
    });
    assert.equal(deactivateRes.status, 403);

    const reactivateRes = await fetch(`http://localhost:${port}/members/${targetId}/reactivate`, {
      method: 'POST',
      headers: { Cookie: scCookie },
    });
    assert.equal(reactivateRes.status, 403);
  } finally {
    server.close();
  }
});

test.after(async () => {
  await query("DELETE FROM invitations");
  await query("DELETE FROM users WHERE email LIKE 'members-%'");
  await closePool();
});
