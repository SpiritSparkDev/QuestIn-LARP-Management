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

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Reg', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`reg-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeEvent() {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active) VALUES ('Reg Test Con', '2027-08-01', true) RETURNING id"
  );
  return rows[0].id;
}

async function makeEventNamed(name, eventDate) {
  const { rows } = await query(
    'INSERT INTO events (name, event_date, is_active) VALUES ($1, $2, true) RETURNING id',
    [name, eventDate]
  );
  return rows[0].id;
}

// The 3 seeded groups have no "mitglieder-menu access but restricted
// accountFields" combination (moderator/admin both get full accountFields by
// default) -- Finding-3-style tests need exactly that, same throwaway-group
// approach as tests/integration/checkin.test.js's makeCustomGroupUserAndSession.
async function makeCustomGroupUserAndSession(overrides) {
  const key = `reg_custom_${crypto.randomUUID().slice(0, 8)}`;
  await query(
    `INSERT INTO groups (key, name, visible_menus, account_fields, can_edit_characters, can_override_checkin_status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      key, key,
      JSON.stringify(overrides.visibleMenus ?? []),
      JSON.stringify(overrides.accountFields ?? []),
      overrides.canEditCharacters ?? false,
      overrides.canOverrideCheckinStatus ?? false,
    ]
  );
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Reg', 'Custom', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`reg-custom-${crypto.randomUUID()}@example.com`, key]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeCharacter(port, cookie, characterClass = 'sc', name = 'Test Char') {
  const res = await fetch(`http://localhost:${port}/characters`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ class: characterClass, name }),
  });
  const { id } = await res.json();
  return id;
}

test('a participant can register and unregister for an event', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const characterId = await makeCharacter(port, cookie);

    const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(registerRes.status, 201);
    const registration = await registerRes.json();
    assert.equal(registration.status, 'pending');

    const dupRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
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

test('the same sc character cannot be used to register for a second event; freed again after unregistering', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventA = await makeEvent();
    const eventB = await makeEventNamed('Zweites Con', '2027-09-01');
    const characterId = await makeCharacter(port, cookie);

    const firstReg = await fetch(`http://localhost:${port}/events/${eventA}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(firstReg.status, 201);

    const secondReg = await fetch(`http://localhost:${port}/events/${eventB}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(secondReg.status, 409);

    await fetch(`http://localhost:${port}/events/${eventA}/register`, { method: 'DELETE', headers: { Cookie: cookie } });

    const thirdReg = await fetch(`http://localhost:${port}/events/${eventB}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(thirdReg.status, 201);
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
    const characterId = await makeCharacter(port, cookie);

    await query(
      "INSERT INTO registrations (user_id, event_id, status, character_id) VALUES ($1, $2, 'checked_in', $3)",
      [userId, eventId, characterId]
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
    const characterId = await makeCharacter(port, cookie, 'sc', 'Aldric');

    const registerRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(registerRes.status, 201);

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
    // A needs two distinct sc characters here: an sc character can now be
    // used for at most one registration ever, so reusing the same one across
    // eventId1 and eventId2 would 409 on the second call.
    const aCharacterId = await makeCharacter(port, a.cookie);
    const aCharacterId2 = await makeCharacter(port, a.cookie, 'sc', 'Test Char 2');
    const bCharacterId = await makeCharacter(port, b.cookie);

    await fetch(`http://localhost:${port}/events/${eventId1}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: aCharacterId }),
    });
    await fetch(`http://localhost:${port}/events/${eventId2}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: aCharacterId2 }),
    });
    await fetch(`http://localhost:${port}/events/${eventId1}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: b.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: bCharacterId }),
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

test('a participant can self-register with a self-service con_role (sc/nsc/helfer)', async () => {
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
    const orgaCharacterId = await makeCharacter(port, orga.cookie);

    // orga can't self-register as orga (no one holds that role for this event yet) -
    // register as a self-service role, then force-promote via direct SQL to bootstrap.
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: orga.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: orgaCharacterId }),
    });
    await query(
      "UPDATE registrations SET con_role = 'orga', character_id = NULL WHERE event_id = $1 AND user_id = $2",
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
    const targetCharacterId = await makeCharacter(port, target.cookie);
    const bystanderCharacterId = await makeCharacter(port, bystander.cookie);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: target.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: targetCharacterId }),
    });
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: bystanderCharacterId }),
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
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Wache Eins');

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/con-role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', characterId: nscCharacterId }),
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

test('registering with con_role sc and no characterId is rejected', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc' }),
    });
    assert.equal(res.status, 400);
  });
});

test('registering with con_role sc and someone else\'s characterId is rejected', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();
    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id: characterId } = await charRes.json();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal(res.status, 403);
  });
});

test('registering with con_role nsc and an sc-class character is rejected (class mismatch)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id: characterId } = await charRes.json();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', characterId }),
    });
    assert.equal(res.status, 400);
  });
});

test('registering with con_role helfer and a characterId set is rejected', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const charRes = await fetch(`http://localhost:${port}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Aldric' }),
    });
    const { id: characterId } = await charRes.json();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', characterId }),
    });
    assert.equal(res.status, 400);
  });
});

test('registering with con_role nsc and no characterId now succeeds', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.con_role, 'nsc');
    assert.equal(body.character_id, null);
  });
});

test('registering with con_role nsc and an own nsc-class character still works', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', characterId: nscCharacterId }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).character_id, nscCharacterId);
  });
});

test('registering with con_role sc and nscAvailable=true stores both, with an optional nsc character', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: true, nscCharacterId }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.con_role, 'sc');
    assert.equal(body.character_id, scCharacterId);
    assert.equal(body.nsc_available, true);
    assert.equal(body.nsc_character_id, nscCharacterId);
  });
});

test('nscAvailable/nscCharacterId are rejected for any con_role other than sc', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', nscAvailable: true }),
    });
    assert.equal(res.status, 400);
  });
});

test('nscCharacterId without nscAvailable=true is rejected', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: false, nscCharacterId }),
    });
    assert.equal(res.status, 400);
  });
});

test('an sc-class character cannot be used as nscCharacterId (class mismatch)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const otherScCharacterId = await makeCharacter(port, cookie, 'sc', 'Bram');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: true, nscCharacterId: otherScCharacterId }),
    });
    assert.equal(res.status, 400);
  });
});

test('an nsc character reused as nscCharacterId across two sc registrations is allowed (nsc stays reusable)', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId1 = await makeEventNamed('Reg Test Con NSC-Reuse A', '2027-09-01');
    const eventId2 = await makeEventNamed('Reg Test Con NSC-Reuse B', '2027-09-02');
    const scCharacterId1 = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const scCharacterId2 = await makeCharacter(port, cookie, 'sc', 'Bram');
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res1 = await fetch(`http://localhost:${port}/events/${eventId1}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId1, nscAvailable: true, nscCharacterId }),
    });
    assert.equal(res1.status, 201);

    const res2 = await fetch(`http://localhost:${port}/events/${eventId2}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId2, nscAvailable: true, nscCharacterId }),
    });
    assert.equal(res2.status, 201);
  });
});

test('GET /registrations includes nscAvailable/nscCharacterId', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: true }),
    });

    const list = await (await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: cookie } })).json();
    const registration = list.find((r) => r.eventId === eventId);
    assert.equal(registration.nscAvailable, true);
    assert.equal(registration.nscCharacterId, null);
  });
});

test('GET /registrations includes characterName and nscCharacterName', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const scCharacterId = await makeCharacter(port, cookie, 'sc', 'Aldric');
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: scCharacterId, nscAvailable: true, nscCharacterId }),
    });

    const list = await (await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: cookie } })).json();
    const registration = list.find((r) => r.eventId === eventId);
    assert.equal(registration.characterName, 'Aldric');
    assert.equal(registration.nscCharacterName, 'Elenwe');
  });
});

test('GET /registrations has null characterName/nscCharacterName for a helfer registration', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const list = await (await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: cookie } })).json();
    const registration = list.find((r) => r.eventId === eventId);
    assert.equal(registration.characterName, null);
    assert.equal(registration.nscCharacterName, null);
  });
});

test('a non-privileged user cannot register with a self-service con_role for an inactive event', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const { query } = await import('../../backend/db.js');
    const { rows } = await query(
      "INSERT INTO events (name, event_date, is_active) VALUES ('Inactive Con', '2027-01-01', false) RETURNING id"
    );
    const eventId = rows[0].id;

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(res.status, 403);
  });
});

test('registering with otFields stores them, returned decrypted via GET /registrations', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', otFields: { conTage: '3', accommodation: 'OT-Zelt', dataSharingOptOut: 'Ja' } }),
    });
    assert.equal(res.status, 201);

    const list = await (await fetch(`http://localhost:${port}/registrations`, { headers: { Cookie: cookie } })).json();
    const registration = list.find((r) => r.eventId === eventId);
    assert.equal(registration.conTage, '3');
    assert.equal(registration.accommodation, 'OT-Zelt');
    assert.equal(registration.dataSharingOptOut, 'Ja');
    assert.equal(registration.craftOffer, null);
  });
});

test('PUT .../ot-fields updates fields for the registration owner and does not touch con_role/character', async () => {
  await withTestServer(async (port) => {
    const { userId, cookie } = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'helfer', otFields: { conTage: '1' } }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conTage: '5', travelMethod: 'Bahn' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.conTage, '5');
    assert.equal(body.travelMethod, 'Bahn');
    assert.equal(body.conRole, 'helfer');
  });
});

test('PUT .../ot-fields is forbidden for a non-owner without mitglieder menu access', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const stranger = await makeUserAndSession();
    const eventId = await makeEvent();

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${owner.userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ conTage: '9' }),
    });
    assert.equal(res.status, 403);
  });
});

test('PUT .../ot-fields allows staff with mitglieder menu access to edit another user\'s registration', async () => {
  await withTestServer(async (port) => {
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');
    const owner = await makeUserAndSession();
    const eventId = await makeEvent();
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Mod', 'Staff', (SELECT id FROM groups WHERE key = 'moderator'), true) RETURNING id",
      [`mod-otfields-${crypto.randomUUID()}@example.com`]
    );
    const modCookie = `session=${(await createSession(rows[0].id)).token}`;

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${owner.userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: modCookie },
      body: JSON.stringify({ accommodation: 'Hütte' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).accommodation, 'Hütte');
  });
});

test('PUT .../ot-fields on an unknown registration returns 404', async () => {
  await withTestServer(async (port) => {
    const { cookie, userId } = await makeUserAndSession();
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conTage: '1' }),
    });
    assert.equal(res.status, 404);
  });
});

test('PUT .../ot-fields rejects a non-owner staff call that sets a field outside their group.accountFields', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const eventId = await makeEvent();
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const staff = await makeCustomGroupUserAndSession({ visibleMenus: ['mitglieder'], accountFields: ['conTage'] });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${owner.userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie },
      body: JSON.stringify({ conTage: '5', accommodation: 'Hütte' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /accommodation/);
  });
});

test('PUT .../ot-fields for a non-owner staff call filters the response to only their group.accountFields', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession();
    const eventId = await makeEvent();
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const staff = await makeCustomGroupUserAndSession({ visibleMenus: ['mitglieder'], accountFields: ['conTage'] });

    const res = await fetch(`http://localhost:${port}/events/${eventId}/registrations/${owner.userId}/ot-fields`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie },
      body: JSON.stringify({ conTage: '5' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.conTage, '5');
    assert.equal('accommodation' in body, false);
    assert.equal('craftOffer' in body, false);
    assert.equal('travelMethod' in body, false);
    assert.equal('dataSharingOptOut' in body, false);
    assert.equal('photoOptOut' in body, false);
  });
});

test('resolveOtFieldsChangeRecipients returns event orga/hilfs_orga plus system admin/moderator, not a plain bystander', async () => {
  await withTestServer(async (port) => {
    const { resolveOtFieldsChangeRecipients } = await import('../../backend/registrations/repository.js');
    const { query } = await import('../../backend/db.js');
    const { createSession } = await import('../../backend/auth/sessions.js');
    const crypto = await import('node:crypto');
    const eventId = await makeEvent();

    async function makeUserWithGroup(groupKey, email) {
      const { rows } = await query(
        "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'R', 'T', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
        [email, groupKey]
      );
      const session = await createSession(rows[0].id);
      return { userId: rows[0].id, cookie: `session=${session.token}`, email };
    }

    const orga = await makeUserWithGroup('mitglied', `orga-recip-${crypto.randomUUID()}@example.com`);
    const admin = await makeUserWithGroup('admin', `admin-recip-${crypto.randomUUID()}@example.com`);
    const bystander = await makeUserWithGroup('mitglied', `bystander-recip-${crypto.randomUUID()}@example.com`);

    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: orga.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    await query("UPDATE registrations SET con_role = 'orga' WHERE event_id = $1 AND user_id = $2", [eventId, orga.userId]);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bystander.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });

    const recipients = await resolveOtFieldsChangeRecipients(eventId);
    assert.ok(recipients.includes(orga.email));
    assert.ok(recipients.includes(admin.email));
    assert.equal(recipients.includes(bystander.email), false);
  });
});

test('registering with con_role nsc, an own nsc-class characterId, and nscAvailable explicitly false succeeds (the corrected frontend payload for "no SC + NSC toggle on")', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession();
    const eventId = await makeEvent();
    const nscCharacterId = await makeCharacter(port, cookie, 'nsc', 'Elenwe');

    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'nsc', characterId: nscCharacterId, nscAvailable: false }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.con_role, 'nsc');
    assert.equal(body.character_id, nscCharacterId);
  });
});

async function makeEventWithCapacity(capacity) {
  const { rows } = await query(
    "INSERT INTO events (name, event_date, is_active, capacity) VALUES ('Kapazitäts-Test-Con', '2027-08-02', true, $1) RETURNING id",
    [capacity]
  );
  return rows[0].id;
}

test('registering at capacity lands on the waitlist instead of pending', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);

    const first = await makeUserAndSession();
    const firstCharacterId = await makeCharacter(port, first.cookie);
    const firstRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: first.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: firstCharacterId }),
    });
    assert.equal((await firstRes.json()).status, 'pending');

    const second = await makeUserAndSession();
    const secondCharacterId = await makeCharacter(port, second.cookie);
    const secondRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: second.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: secondCharacterId }),
    });
    assert.equal(secondRes.status, 201);
    assert.equal((await secondRes.json()).status, 'waitlisted');
  });
});

test('two simultaneous registrations at the last free slot: exactly one pending, one waitlisted', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const a = await makeUserAndSession();
    const aCharacterId = await makeCharacter(port, a.cookie);
    const b = await makeUserAndSession();
    const bCharacterId = await makeCharacter(port, b.cookie);

    const [resA, resB] = await Promise.all([
      fetch(`http://localhost:${port}/events/${eventId}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
        body: JSON.stringify({ conRole: 'sc', characterId: aCharacterId }),
      }),
      fetch(`http://localhost:${port}/events/${eventId}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: b.cookie },
        body: JSON.stringify({ conRole: 'sc', characterId: bCharacterId }),
      }),
    ]);
    const statuses = [(await resA.json()).status, (await resB.json()).status].sort();
    assert.deepEqual(statuses, ['pending', 'waitlisted']);
  });
});

test('an event without capacity never waitlists', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEvent();
    const { userId, cookie } = await makeUserAndSession();
    const characterId = await makeCharacter(port, cookie);
    const res = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ conRole: 'sc', characterId }),
    });
    assert.equal((await res.json()).status, 'pending');
  });
});

test('a waitlisted participant can unregister (row deleted, no error)', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const filler = await makeUserAndSession();
    const fillerCharacterId = await makeCharacter(port, filler.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: filler.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: fillerCharacterId }),
    });

    const waitlisted = await makeUserAndSession();
    const waitlistedCharacterId = await makeCharacter(port, waitlisted.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: waitlisted.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: waitlistedCharacterId }),
    });

    const unregisterRes = await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'DELETE', headers: { Cookie: waitlisted.cookie },
    });
    assert.equal(unregisterRes.status, 200);

    const { rows } = await query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, waitlisted.userId]);
    assert.equal(rows.length, 0);
  });
});

async function makeCustomOverrideUserAndSession() {
  return makeCustomGroupUserAndSession({ visibleMenus: ['checkin'], canOverrideCheckinStatus: true });
}

test('auto-promote: cancelling a confirmed registration promotes the oldest waitlisted person', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const staff = await makeCustomOverrideUserAndSession();

    const first = await makeUserAndSession();
    const firstCharacterId = await makeCharacter(port, first.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: first.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: firstCharacterId }),
    });

    const second = await makeUserAndSession();
    const secondCharacterId = await makeCharacter(port, second.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: second.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: secondCharacterId }),
    });

    const cancelRes = await fetch(`http://localhost:${port}/events/${eventId}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie },
      body: JSON.stringify({ userId: first.userId }),
    });
    assert.equal(cancelRes.status, 200);

    const { rows } = await query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, second.userId]);
    assert.equal(rows[0].status, 'pending');
  });
});

test('auto-promote disabled: cancelling does not promote anyone', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ waitlistAutoPromote: false }),
    });
    const eventId = await makeEventWithCapacity(1);
    const staff = await makeCustomOverrideUserAndSession();

    const first = await makeUserAndSession();
    const firstCharacterId = await makeCharacter(port, first.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: first.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: firstCharacterId }),
    });
    const second = await makeUserAndSession();
    const secondCharacterId = await makeCharacter(port, second.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: second.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: secondCharacterId }),
    });

    await fetch(`http://localhost:${port}/events/${eventId}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie },
      body: JSON.stringify({ userId: first.userId }),
    });

    const { rows } = await query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, second.userId]);
    assert.equal(rows[0].status, 'waitlisted');

    // reset for later tests in this file
    await fetch(`http://localhost:${port}/app-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ waitlistAutoPromote: true }),
    });
  });
});

test('manual promote via the existing status-override endpoint', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const staff = await makeCustomOverrideUserAndSession();

    const filler = await makeUserAndSession();
    const fillerCharacterId = await makeCharacter(port, filler.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: filler.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: fillerCharacterId }),
    });
    const waitlisted = await makeUserAndSession();
    const waitlistedCharacterId = await makeCharacter(port, waitlisted.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: waitlisted.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: waitlistedCharacterId }),
    });

    const promoteRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${waitlisted.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: staff.cookie },
      body: JSON.stringify({ status: 'pending', previousStatus: 'waitlisted' }),
    });
    assert.equal(promoteRes.status, 200);
    assert.equal((await promoteRes.json()).status, 'pending');
  });
});

test('raising an event capacity promotes as many waitlisted people as now fit', async () => {
  await withTestServer(async (port) => {
    const eventId = await makeEventWithCapacity(1);
    const admin = await makeUserAndSession('admin');

    const filler = await makeUserAndSession();
    const fillerCharacterId = await makeCharacter(port, filler.cookie);
    await fetch(`http://localhost:${port}/events/${eventId}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: filler.cookie },
      body: JSON.stringify({ conRole: 'sc', characterId: fillerCharacterId }),
    });

    const waitlistedUsers = [];
    for (let i = 0; i < 2; i += 1) {
      const u = await makeUserAndSession();
      const characterId = await makeCharacter(port, u.cookie);
      await fetch(`http://localhost:${port}/events/${eventId}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: u.cookie },
        body: JSON.stringify({ conRole: 'sc', characterId }),
      });
      waitlistedUsers.push(u);
    }

    await fetch(`http://localhost:${port}/events/${eventId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ capacity: 3 }),
    });

    const { rows } = await query(
      'SELECT status FROM registrations WHERE event_id = $1 AND user_id = ANY($2::uuid[])',
      [eventId, waitlistedUsers.map((u) => u.userId)]
    );
    assert.deepEqual(rows.map((r) => r.status).sort(), ['pending', 'pending']);
  });
});

test.after(async () => {
  // Users created in a reg_custom_* group must be deleted before the group
  // itself (users.group_id -> groups.id has no ON DELETE CASCADE), otherwise
  // these throwaway groups would leak into later test files sharing this DB
  // and break assertions that expect exactly the 3 seeded groups -- same
  // cleanup checkin.test.js does for its own checkin_custom_* groups.
  await query("DELETE FROM users WHERE email LIKE 'reg-custom-%'");
  await query("DELETE FROM groups WHERE key LIKE 'reg_custom_%'");
  await closePool();
});
