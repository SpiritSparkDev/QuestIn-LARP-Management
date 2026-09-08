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
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Checkin', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`checkin-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

// The 3 seeded groups no longer have a "has checkin-menu access but lacks
// some other specific permission" combination (moderator always has both
// canOverrideCheckinStatus and full accountFields; mitglied has neither
// menu access). A handful of permission-boundary tests below need exactly
// that combination, so they build a throwaway group with the one relevant
// permission tweaked, same as POST /groups lets an admin do at runtime.
async function makeCustomGroupUserAndSession(overrides) {
  const key = `checkin_custom_${crypto.randomUUID().slice(0, 8)}`;
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
  return makeUserAndSession(key);
}

async function makeEvent(schema) {
  const { rows } = await query(
    'INSERT INTO events (name, event_date, character_form_schema) VALUES ($1, $2, $3) RETURNING id',
    ['Checkin Test Con', '2027-09-01', JSON.stringify(schema ?? [])]
  );
  return rows[0].id;
}

test('a participant cannot list participants or check anyone in', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();

    const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 403);

    const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    assert.equal(checkinRes.status, 403);

    const checkoutRes = await fetch(`http://localhost:${port}/events/${eventId}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    assert.equal(checkoutRes.status, 403);
  });
});

test('checkin_helper sees the participant list with characters and no encrypted fields, then checks someone in and out', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('moderator');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();

    await query("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'confirmed')", [attendee.userId, eventId]);
    await query(
      "INSERT INTO characters (user_id, event_id, name, data) VALUES ($1, $2, 'Aldric', '{}')",
      [attendee.userId, eventId]
    );

    const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: helper.cookie } });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    const entry = list.find((p) => p.userId === attendee.userId);
    assert.ok(entry);
    assert.equal(entry.status, 'confirmed');
    assert.deepEqual(entry.characters.map((c) => c.name), ['Aldric']);
    assert.equal(JSON.stringify(entry).includes('_enc'), false);
    assert.equal('address' in entry, false);

    const admin = await makeUserAndSession('admin');
    const adminListRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: admin.cookie } });
    assert.equal(adminListRes.status, 200);

    const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });
    assert.equal(checkinRes.status, 200);
    assert.equal((await checkinRes.json()).status, 'checked_in');

    const doubleCheckinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });
    assert.equal(doubleCheckinRes.status, 409);

    const checkoutRes = await fetch(`http://localhost:${port}/events/${eventId}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });
    assert.equal(checkoutRes.status, 200);
    assert.equal((await checkoutRes.json()).status, 'checked_out');
  });
});

test('GET /events/:id/participants for an unknown event returns 404', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('moderator');

    const res = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/participants`, {
      headers: { Cookie: helper.cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('checking in a user with no registration for the event returns 404', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('moderator');
    const stranger = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: stranger.userId }),
    });
    assert.equal(res.status, 404);
  });
});

test('two concurrent check-ins for the same attendee: exactly one succeeds', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('moderator');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();

    await query("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'confirmed')", [attendee.userId, eventId]);

    const doCheckin = () => fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });

    const [resA, resB] = await Promise.all([doCheckin(), doCheckin()]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const okRes = resA.status === 200 ? resA : resB;
    assert.equal((await okRes.json()).status, 'checked_in');
  });
});

test('a user without canOverrideCheckinStatus cannot use the override endpoint', async () => {
  await withTestServer(async (port) => {
    // Needs 'checkin' in visibleMenus (so the request reaches the handler) but
    // canOverrideCheckinStatus: false, so this test proves the override check
    // itself rejects it, not the pre-existing requireMenu('checkin') gate.
    const stranger = await makeCustomGroupUserAndSession({ visibleMenus: ['checkin'], canOverrideCheckinStatus: false });
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [stranger.userId, eventId]);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${stranger.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ status: 'checked_in' }),
    });
    assert.equal(res.status, 403);
  });
});

test('a user without canOverrideCheckinStatus cannot use the approve endpoint', async () => {
  await withTestServer(async (port) => {
    const stranger = await makeCustomGroupUserAndSession({ visibleMenus: ['checkin'], canOverrideCheckinStatus: false });
    const eventId = await makeEvent();
    const res = await fetch(`http://localhost:${port}/events/${eventId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    assert.equal(res.status, 403);
  });
});

test('a user without canOverrideCheckinStatus cannot use the cancel endpoint', async () => {
  await withTestServer(async (port) => {
    const stranger = await makeCustomGroupUserAndSession({ visibleMenus: ['checkin'], canOverrideCheckinStatus: false });
    const eventId = await makeEvent();
    const res = await fetch(`http://localhost:${port}/events/${eventId}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: stranger.cookie },
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    assert.equal(res.status, 403);
  });
});

test('a user with canOverrideCheckinStatus can set a status directly, including a backward transition', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const toCheckedOut = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'checked_out', previousStatus: 'pending' }),
    });
    assert.equal(toCheckedOut.status, 200);
    const checkedOutBody = await toCheckedOut.json();
    assert.equal(checkedOutBody.status, 'checked_out');
    assert.equal(checkedOutBody.checked_in_at, null, 'skipping straight to checked_out must not fabricate checked_in_at');
    assert.ok(checkedOutBody.checked_out_at);

    const backToConfirmed = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'confirmed', previousStatus: 'checked_out' }),
    });
    assert.equal(backToConfirmed.status, 200);
    const confirmedBody = await backToConfirmed.json();
    assert.equal(confirmedBody.status, 'confirmed');
    assert.equal(confirmedBody.checked_in_at, null);
    assert.equal(confirmedBody.checked_out_at, null);
  });
});

test('overriding to checked_out preserves an already-set checked_in_at instead of overwriting it', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('moderator');
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();
    await query("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'confirmed')", [attendee.userId, eventId]);

    const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });
    assert.equal(checkinRes.status, 200);
    const { checked_in_at: originalCheckedInAt } = await checkinRes.json();
    assert.ok(originalCheckedInAt);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const overrideRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'checked_out', previousStatus: 'checked_in' }),
    });
    assert.equal(overrideRes.status, 200);
    const overrideBody = await overrideRes.json();
    assert.equal(overrideBody.status, 'checked_out');
    assert.equal(overrideBody.checked_in_at, originalCheckedInAt, 'checked_in_at set by the normal flow must survive the override');
  });
});

test('the override endpoint rejects an invalid status value', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'nonsense' }),
    });
    assert.equal(res.status, 400);
  });
});

test('the override endpoint returns 404 for a user with no registration for the event', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const stranger = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();

    const res = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${stranger.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'checked_in', previousStatus: 'pending' }),
    });
    assert.equal(res.status, 404);
  });
});

test('two concurrent overrides on the same registration with the same previousStatus: exactly one succeeds', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const doOverride = (status) => fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status, previousStatus: 'pending' }),
    });

    const [resA, resB] = await Promise.all([doOverride('checked_in'), doOverride('checked_out')]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  });
});

test('the normal checkin/checkout flow still works unchanged alongside the override endpoint', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('moderator');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();
    await query("INSERT INTO registrations (user_id, event_id, status) VALUES ($1, $2, 'confirmed')", [attendee.userId, eventId]);

    const checkinRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: helper.cookie },
      body: JSON.stringify({ userId: attendee.userId }),
    });
    assert.equal(checkinRes.status, 200);
    assert.equal((await checkinRes.json()).status, 'checked_in');
  });
});

test('overriding directly from pending to checked_out does not fabricate a checked_in_at timestamp', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);

    const overrideRes = await fetch(`http://localhost:${port}/events/${eventId}/checkin/${attendee.userId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ status: 'checked_out', previousStatus: 'pending' }),
    });
    assert.equal(overrideRes.status, 200);
    const overrideBody = await overrideRes.json();
    assert.equal(overrideBody.checked_in_at, null, 'check-in never happened, so checked_in_at must stay null');
    assert.ok(overrideBody.checked_out_at, 'checkout genuinely happened, so checked_out_at must be set');
  });
});

test('participants list exposes only the OT fields the viewer\'s group is allowed to see', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    // Every seeded group with checkin-menu access (moderator) also gets full
    // accountFields by default, so a custom group is needed to exercise a
    // checkin-capable viewer that is NOT allowed to see OT fields.
    const helper = await makeCustomGroupUserAndSession({ visibleMenus: ['checkin'], accountFields: [], canOverrideCheckinStatus: true });
    const attendee = await makeUserAndSession('mitglied');
    const eventId = await makeEvent();
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);
    const patchRes = await fetch(`http://localhost:${port}/members/${attendee.userId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ phone: '0123456789', medicalNotes: 'Erdnussallergie' }),
    });
    assert.equal(patchRes.status, 200);

    const adminList = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: admin.cookie } });
    const adminEntry = (await adminList.json()).find((p) => p.userId === attendee.userId);
    assert.equal(adminEntry.otFields.phone, '0123456789');
    assert.equal(adminEntry.otFields.medicalNotes, 'Erdnussallergie');

    const helperList = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: helper.cookie } });
    const helperEntry = (await helperList.json()).find((p) => p.userId === attendee.userId);
    assert.deepEqual(helperEntry.otFields, {});
    assert.equal(JSON.stringify(helperEntry).includes('0123456789'), false);
  });
});

test('participants list filters character (IT) fields by canOverrideCheckinStatus and the schema\'s public flag', async () => {
  await withTestServer(async (port) => {
    const schema = [
      { key: 'faction', label: 'Fraktion', type: 'text', public: true },
      { key: 'secretGoal', label: 'Geheimes Ziel', type: 'text', public: false },
    ];
    const eventId = await makeEvent(schema);
    const admin = await makeUserAndSession('admin'); // canOverrideCheckinStatus: true
    const hilfsSl = await makeCustomGroupUserAndSession({ visibleMenus: ['checkin'], canOverrideCheckinStatus: false });
    const attendee = await makeUserAndSession('mitglied');
    await query('INSERT INTO registrations (user_id, event_id) VALUES ($1, $2)', [attendee.userId, eventId]);
    await query(
      "INSERT INTO characters (user_id, event_id, name, data) VALUES ($1, $2, 'Aldric', $3)",
      [attendee.userId, eventId, JSON.stringify({ faction: 'Nordbund', secretGoal: 'Den Thron stürzen' })]
    );

    const adminList = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: admin.cookie } });
    const adminChar = (await adminList.json()).find((p) => p.userId === attendee.userId).characters[0];
    assert.equal(adminChar.data.faction, 'Nordbund');
    assert.equal(adminChar.data.secretGoal, 'Den Thron stürzen');

    const hilfsSlList = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: hilfsSl.cookie } });
    const hilfsSlChar = (await hilfsSlList.json()).find((p) => p.userId === attendee.userId).characters[0];
    assert.equal(hilfsSlChar.data.faction, 'Nordbund');
    assert.equal('secretGoal' in hilfsSlChar.data, false);
  });
});

test('participants list includes an open, event-scoped invitation as a "notified" entry with no userId', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('moderator');
    const eventId = await makeEvent();
    const admin = await makeUserAndSession('admin');

    const inviteRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ email: `notified-${crypto.randomUUID()}@example.com`, firstName: 'Notified', lastName: 'Person', group: 'mitglied', eventId }),
    });
    assert.equal(inviteRes.status, 201);
    const invitation = await inviteRes.json();

    const listRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: helper.cookie } });
    const list = await listRes.json();
    const entry = list.find((p) => p.invitationId === invitation.id);
    assert.ok(entry);
    assert.equal(entry.userId, null);
    assert.equal(entry.status, 'notified');
    assert.equal(entry.name, 'Notified Person');
  });
});

test('a redeemed invitation with no registration yet still shows as "notified", and disappears once registered', async () => {
  await withTestServer(async (port) => {
    const helper = await makeUserAndSession('moderator');
    const eventId = await makeEvent();
    const admin = await makeUserAndSession('admin');
    const email = `notified-redeemed-${crypto.randomUUID()}@example.com`;

    const inviteRes = await fetch(`http://localhost:${port}/members/invite`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ email, firstName: 'Redeemed', lastName: 'Notified', group: 'mitglied', eventId }),
    });
    const invitation = await inviteRes.json();
    const { rows } = await query('SELECT token FROM invitations WHERE id = $1', [invitation.id]);

    const redeemRes = await fetch(`http://localhost:${port}/auth/invite/redeem`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rows[0].token, password: 'correct horse battery staple' }),
    });
    assert.equal(redeemRes.status, 200);
    const newUserId = (await redeemRes.json()).id;

    const beforeRegisterRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: helper.cookie } });
    const beforeRegisterList = await beforeRegisterRes.json();
    assert.ok(beforeRegisterList.find((p) => p.invitationId === invitation.id && p.status === 'notified'));

    const newUserCookie = `session=${(await createSession(newUserId)).token}`;
    await fetch(`http://localhost:${port}/events/${eventId}/register`, { method: 'POST', headers: { Cookie: newUserCookie } });

    const afterRegisterRes = await fetch(`http://localhost:${port}/events/${eventId}/participants`, { headers: { Cookie: helper.cookie } });
    const afterRegisterList = await afterRegisterRes.json();
    assert.equal(afterRegisterList.some((p) => p.invitationId === invitation.id), false);
    assert.ok(afterRegisterList.find((p) => p.userId === newUserId && p.status === 'pending'));
  });
});

test.after(async () => {
  // Users created in a checkin_custom_* group must be deleted before the
  // group itself (users.group_id -> groups.id has no ON DELETE CASCADE),
  // otherwise these throwaway groups would leak into every later test file
  // sharing this DB and break assertions that expect exactly the 3 seeded
  // groups.
  await query("DELETE FROM users WHERE email LIKE 'checkin-checkin_custom_%'");
  await query("DELETE FROM groups WHERE key LIKE 'checkin_custom_%'");
  await closePool();
});
