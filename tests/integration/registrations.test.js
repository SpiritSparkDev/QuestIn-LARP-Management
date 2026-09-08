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

async function makeUserAndSession() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Reg', 'Test', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
    [`reg-${crypto.randomUUID()}@example.com`]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date) VALUES ('Reg Test Con', '2027-08-01') RETURNING id"
  );
  return rows[0].id;
}

async function makeEventNamed(name, eventDate) {
  const { rows } = await query(
    'INSERT INTO events (name, event_date) VALUES ($1, $2) RETURNING id',
    [name, eventDate]
  );
  return rows[0].id;
}

test('a participant can register and unregister for an event', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    assert.equal(registerRes.status, 201);
    const registration = await registerRes.json();
    assert.equal(registration.status, 'pending');

    const dupRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    assert.equal(dupRes.status, 409);

    const unregisterRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(unregisterRes.status, 200);

    const { rows } = await query(
      'SELECT * FROM registrations WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );
    assert.equal(rows.length, 0);
  });
});

test('registering for an unknown event returns 404', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();

    const res = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    assert.equal(res.status, 404);
  });
});

test('unregistering without an existing registration returns 404', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('a checked-in participant cannot unregister', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    await query(
      "INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'checked_in')",
      [userId, eventId]
    );

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(res.status, 409);
  });
});

test('two concurrent approvals of the same registration: exactly one succeeds', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const { rows: helperRows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Race', 'Helper', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`reg-helper-${crypto.randomUUID()}@example.com`]
    );
    const helperSession = await createSession(helperRows[0].id);
    const helperCookie = `session=${helperSession.token}`;
    const eventId = await makeEvent();

    const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    assert.equal(registerRes.status, 201);
    await query(
      "INSERT INTO characters (user_id, event_id, name, data) VALUES ($1, $2, 'Aldric', '{}')",
      [userId, eventId]
    );

    const doApprove = () => fetch(`http://localhost:${port}/events/${eventId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helperCookie },
      body: JSON.stringify({ userId }),
    });

    const [resA, resB] = await Promise.all([doApprove(), doApprove()]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const { rows } = await query(
      'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'confirmed');
  });
});

test('GET /registrations lists only the calling participant\'s registrations', async () => {
  await withTestServer(async (port) => {
    const a = await makeUserAndSession();
    const b = await makeUserAndSession();
    const eventId1 = await makeEventNamed('Reg Test Con A', '2027-08-02');
    const eventId2 = await makeEventNamed('Reg Test Con B', '2027-08-03');

    await fetch(`http://localhost:${port}/events/${eventId1}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    await fetch(`http://localhost:${port}/events/${eventId2}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    await fetch(`http://localhost:${port}/events/${eventId1}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: b.cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });

    const res = await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 200);
    const list = await res.json();
    // Exactly A's two registrations - if the query weren't scoped to A's
    // user_id, B's shared registration for eventId1 would show up as a
    // duplicate row and push the length past 2.
    assert.equal(list.length, 2);
    const eventIds = list.map((r) => r.eventId).sort();
    assert.deepEqual(eventIds, [eventId1, eventId2].sort());
    for (const r of list) {
      assert.ok(r.eventName);
      assert.ok(r.eventDate);
      assert.equal(r.status, 'pending');
    }
  });
});

test('a participant can self-register with a self-service con_role (sc/nsc/gsc/helfer)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.conRole ?? body.con_role, 'helfer');
  });
});

test('a plain member cannot self-register with con_role orga', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'orga' }),
    });
    assert.equal(res.status, 403);
  });
});

test('a moderator can self-register with con_role orga', async () => {
  await withTestServer(async (port) => {
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mod', 'Test', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`mod-${crypto.randomUUID()}@example.com`]
    );
    const session = await createSession(rows[0].id);
    const cookie = `session=${session.token}`;
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'orga' }),
    });
    assert.equal(res.status, 201);
  });
});

test('an event-scoped orga can promote another participant to hilfs_orga; a non-orga participant cannot', async () => {
  await withTestServer(async (port) => {
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');

    async function makeMitglied() {
      const { rows } = await query(
        "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'M', 'T', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
        [`mitglied-${crypto.randomUUID()}@example.com`]
      );
      const session = await createSession(rows[0].id);
      return { userId: rows[0].id, cookie: `session=${session.token}` };
    }

    const orga = await makeMitglied();
    const target = await makeMitglied();
    const bystander = await makeMitglied();
    const eventId = await makeEvent();

    // orga can't self-register as orga (no one holds that role for this event yet) -
    // register as a self-service role, then force-promote via direct SQL to bootstrap.
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: orga.cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    await query(
      "UPDATE registrations SET con_role = 'orga' WHERE event_id = $1 AND user_id = $2",
      [eventId, orga.userId]
    );
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: target.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const promoted = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${target.userId}/con-role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: orga.cookie },
      body: JSON.stringify({ conRole: 'hilfs_orga' }),
    });
    assert.equal(promoted.status, 200);
    assert.equal((await promoted.json()).con_role, 'hilfs_orga');

    const denied = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${target.userId}/con-role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'orga' }),
    });
    assert.equal(denied.status, 403);
  });
});

test('a bystander cannot use the promotion endpoint to rewrite another participant\'s con_role to a self-service value', async () => {
  await withTestServer(async (port) => {
    const target = await makeUserAndSession();
    const bystander = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: target.cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });

    // Bystander holds no staff role for this event, yet tries to flip the
    // target's registration to another self-service value (e.g. demoting
    // them to 'helfer'). This must be forbidden even though 'helfer' itself
    // needs no grant permission for a user's OWN registration.
    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${target.userId}/con-role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(res.status, 403);

    const { rows } = await query(
      'SELECT con_role FROM registrations WHERE event_id = $1 AND user_id = $2',
      [eventId, target.userId]
    );
    assert.equal(rows[0].con_role, 'sc');
  });
});

test('a user can change their own registration\'s con_role to a self-service value via the promotion endpoint', async () => {
  await withTestServer(async (port) => {
    const { cookie, userId } = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/con-role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).con_role, 'nsc');
  });
});

test('approving a registration with con_role helfer succeeds without a character', async () => {
  await withTestServer(async (port) => {
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mod', 'Approve', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`mod-approve-${crypto.randomUUID()}@example.com`]
    );
    const modSession = await createSession(rows[0].id);
    const modCookie = `session=${modSession.token}`;
    const helferUser = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helferUser.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: modCookie },
      body: JSON.stringify({ userId: helferUser.userId }),
    });
    assert.equal(res.status, 200);
  });
});

test('approving a registration with con_role sc without a character is rejected with 409', async () => {
  await withTestServer(async (port) => {
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mod', 'Approve', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`mod-approve-${crypto.randomUUID()}@example.com`]
    );
    const modCookie = `session=${(await createSession(rows[0].id)).token}`;
    const scUser = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: scUser.cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: modCookie },
      body: JSON.stringify({ userId: scUser.userId }),
    });
    assert.equal(res.status, 409);
  });
});

test('approving a registration with con_role nsc requires an NSC character (account-wide, not event-scoped)', async () => {
  await withTestServer(async (port) => {
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mod', 'Approve', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`mod-approve-${crypto.randomUUID()}@example.com`]
    );
    const modCookie = `session=${(await createSession(rows[0].id)).token}`;
    const nscUser = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: nscUser.cookie },
      body: JSON.stringify({ conRole: 'nsc' }),
    });

    const rejectRes = await fetch(`http://localhost:${port}/events/${eventId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: modCookie },
      body: JSON.stringify({ userId: nscUser.userId }),
    });
    assert.equal(rejectRes.status, 409);

    // NSC characters are account-wide: event_id is always NULL for class 'nsc'.
    await query(
      "INSERT INTO characters (user_id, event_id, class, name, data) VALUES ($1, NULL, 'nsc', 'Narrator', '{}')",
      [nscUser.userId]
    );

    const approveRes = await fetch(`http://localhost:${port}/events/${eventId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: modCookie },
      body: JSON.stringify({ userId: nscUser.userId }),
    });
    assert.equal(approveRes.status, 200);
  });
});

test.after(async () => {
  await closePool();
});
