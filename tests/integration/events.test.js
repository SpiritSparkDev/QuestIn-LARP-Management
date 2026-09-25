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

async function makeUserAndSession(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Events', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`events-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const { createSession } = await import('../../backend/auth/sessions.js');
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('admin can create an event; participant cannot', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const participant = await makeUserAndSession('mitglied');
    const payload = {
      name: 'Sommercon 2027',
      eventDate: '2027-07-15',
    };

    const asAdmin = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify(payload),
    });
    assert.equal(asAdmin.status, 201);
    const created = await asAdmin.json();
    assert.equal(created.name, 'Sommercon 2027');
    assert.equal(created.event_date, '2027-07-15');

    const asParticipant = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify(payload),
    });
    assert.equal(asParticipant.status, 403);
  });
});

test('any authenticated user can list and get events; unknown id is 404', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const participant = await makeUserAndSession('mitglied');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Wintercon', eventDate: '2027-01-10' }),
    });
    const { id } = await createRes.json();

    const listRes = await fetch(`http://localhost:${port}/events`, { headers: { Cookie: participant.cookie } });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(list.some((e) => e.id === id));

    const getRes = await fetch(`http://localhost:${port}/events/${id}`, { headers: { Cookie: participant.cookie } });
    assert.equal(getRes.status, 200);

    const missingRes = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}`, { headers: { Cookie: participant.cookie } });
    assert.equal(missingRes.status, 404);
  });
});

test('admin can update an event\'s name', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Frühlingscon', eventDate: '2027-04-01' }),
    });
    const { id } = await createRes.json();

    const updateRes = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Frühlingscon (Update)' }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, 'Frühlingscon (Update)');
  });
});

test('GET /events/:id with a malformed UUID returns 400, not 500', async () => {
  await withTestServer(async (port) => {
    const participant = await makeUserAndSession();

    const res = await fetch(`http://localhost:${port}/events/not-a-valid-uuid`, {
      headers: { Cookie: participant.cookie },
    });
    assert.equal(res.status, 400);
  });
});

test('admin can activate an event; activating one deactivates all others; participant cannot activate', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const participant = await makeUserAndSession('mitglied');

    async function createEvent(name) {
      const res = await fetch(`http://localhost:${port}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        body: JSON.stringify({ name, eventDate: '2027-10-01' }),
      });
      return res.json();
    }

    const eventA = await createEvent('Herbstcon A');
    const eventB = await createEvent('Herbstcon B');

    const activateA = await fetch(`http://localhost:${port}/events/${eventA.id}/activate`, {
      method: 'POST', headers: { Cookie: admin.cookie },
    });
    assert.equal(activateA.status, 200);
    assert.equal((await activateA.json()).is_active, true);

    const activateB = await fetch(`http://localhost:${port}/events/${eventB.id}/activate`, {
      method: 'POST', headers: { Cookie: admin.cookie },
    });
    assert.equal(activateB.status, 200);
    assert.equal((await activateB.json()).is_active, true);

    const getA = await fetch(`http://localhost:${port}/events/${eventA.id}`, { headers: { Cookie: admin.cookie } });
    assert.equal((await getA.json()).is_active, false);

    const asParticipant = await fetch(`http://localhost:${port}/events/${eventA.id}/activate`, {
      method: 'POST', headers: { Cookie: participant.cookie },
    });
    assert.equal(asParticipant.status, 403);

    const unknownEvent = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}/activate`, {
      method: 'POST', headers: { Cookie: admin.cookie },
    });
    assert.equal(unknownEvent.status, 404);
  });
});

test('events.code round-trips through POST/GET/PUT, can be changed, and can be cleared', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Codecon', eventDate: '2027-09-01', code: 'P17/2027' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.code, 'P17/2027');

    const getRes = await fetch(`http://localhost:${port}/events/${created.id}`, { headers: { Cookie: admin.cookie } });
    assert.equal((await getRes.json()).code, 'P17/2027');

    const changeRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ code: 'P18/2028' }),
    });
    assert.equal((await changeRes.json()).code, 'P18/2028');

    // A PUT that omits code entirely must preserve it (the same partial-update
    // contract every other optional field on this route already has).
    const untouchedRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Codecon Renamed' }),
    });
    const untouched = await untouchedRes.json();
    assert.equal(untouched.name, 'Codecon Renamed');
    assert.equal(untouched.code, 'P18/2028');

    // A PUT that explicitly clears code (what the admin form sends when the
    // field is emptied) must actually clear it, not silently preserve the
    // old value.
    const clearRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ code: null }),
    });
    assert.equal((await clearRes.json()).code, null);

    const getAfterClear = await fetch(`http://localhost:${port}/events/${created.id}`, { headers: { Cookie: admin.cookie } });
    assert.equal((await getAfterClear.json()).code, null);
  });
});

test('admin can delete an event with no registrations; cannot delete one that has registrations; participant cannot delete', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const participant = await makeUserAndSession('mitglied');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Löschbares Event', eventDate: '2027-11-01' }),
    });
    const { id } = await createRes.json();

    const asParticipant = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'DELETE', headers: { Cookie: participant.cookie },
    });
    assert.equal(asParticipant.status, 403);

    const registerRes = await fetch(`http://localhost:${port}/events/${id}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(registerRes.status, 403); // event isn't active yet -- fine, we just need SOME registration row

    // Use an active event instead, so the registration above actually lands.
    await fetch(`http://localhost:${port}/events/${id}/activate`, { method: 'POST', headers: { Cookie: admin.cookie } });
    const registerActiveRes = await fetch(`http://localhost:${port}/events/${id}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(registerActiveRes.status, 201);

    const blockedDelete = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'DELETE', headers: { Cookie: admin.cookie },
    });
    assert.equal(blockedDelete.status, 409);

    await fetch(`http://localhost:${port}/events/${id}/register`, { method: 'DELETE', headers: { Cookie: participant.cookie } });

    const okDelete = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'DELETE', headers: { Cookie: admin.cookie },
    });
    assert.equal(okDelete.status, 200);
    assert.deepEqual(await okDelete.json(), { deleted: true });

    const getAfter = await fetch(`http://localhost:${port}/events/${id}`, { headers: { Cookie: admin.cookie } });
    assert.equal(getAfter.status, 404);

    const unknownDelete = await fetch(`http://localhost:${port}/events/${crypto.randomUUID()}`, {
      method: 'DELETE', headers: { Cookie: admin.cookie },
    });
    assert.equal(unknownDelete.status, 404);
  });
});

test('admin can force-delete an event with registrations; registrations are cascaded away and notify does not throw', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const participant = await makeUserAndSession('mitglied');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Erzwungen löschbares Event', eventDate: '2027-11-02' }),
    });
    const { id } = await createRes.json();
    await fetch(`http://localhost:${port}/events/${id}/activate`, { method: 'POST', headers: { Cookie: admin.cookie } });
    const registerRes = await fetch(`http://localhost:${port}/events/${id}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: participant.cookie },
      body: JSON.stringify({ conRole: 'helfer' }),
    });
    assert.equal(registerRes.status, 201);

    // Without force, still blocked -- force is opt-in, not the new default.
    const blockedDelete = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ force: false }),
    });
    assert.equal(blockedDelete.status, 409);

    const forceDelete = await fetch(`http://localhost:${port}/events/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ force: true, notify: true }),
    });
    assert.equal(forceDelete.status, 200);
    assert.deepEqual(await forceDelete.json(), { deleted: true });

    const getAfter = await fetch(`http://localhost:${port}/events/${id}`, { headers: { Cookie: admin.cookie } });
    assert.equal(getAfter.status, 404);

    const { rows: remainingRegistrations } = await query('SELECT 1 FROM registrations WHERE event_id = $1', [id]);
    assert.equal(remainingRegistrations.length, 0);
  });
});

test('capacity can be set on create, updated, and cleared back to unlimited', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Kapazitäts-Con', eventDate: '2027-09-01', capacity: 30 }),
    });
    const created = await createRes.json();
    assert.equal(created.capacity, 30);

    const raiseRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ capacity: 50 }),
    });
    const raised = await raiseRes.json();
    assert.equal(raised.capacity, 50);

    const clearRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ capacity: null, clearCapacity: true }),
    });
    const cleared = await clearRes.json();
    assert.equal(cleared.capacity, null);
  });
});

test('an event created without capacity defaults to unlimited (null)', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Unbegrenzt-Con', eventDate: '2027-09-02' }),
    });
    const created = await res.json();
    assert.equal(created.capacity, null);
  });
});

test('flags can be set on create, updated, and cleared back to empty', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');

    const createRes = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Flags-Con', eventDate: '2027-09-03', flags: ['GSC', ' VP ', 'GSC', ''] }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    // Trimmed, deduplicated, empty strings dropped, order preserved.
    assert.deepEqual(created.flags, ['GSC', 'VP']);

    const updateRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ flags: ['Ersthelfer'] }),
    });
    const updated = await updateRes.json();
    assert.deepEqual(updated.flags, ['Ersthelfer']);

    // A PUT that omits flags entirely must preserve it (same partial-update
    // contract every other optional field on this route already has).
    const untouchedRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Flags-Con Renamed' }),
    });
    const untouched = await untouchedRes.json();
    assert.deepEqual(untouched.flags, ['Ersthelfer']);

    // An explicit empty array clears it -- distinct from omitting the field.
    const clearRes = await fetch(`http://localhost:${port}/events/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ flags: [] }),
    });
    const cleared = await clearRes.json();
    assert.deepEqual(cleared.flags, []);
  });
});

test('an event created without flags defaults to an empty array', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Flaglos-Con', eventDate: '2027-09-04' }),
    });
    const created = await res.json();
    assert.deepEqual(created.flags, []);
  });
});

test('creating an event with a non-array flags value is rejected', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ name: 'Kaputt-Con', eventDate: '2027-09-05', flags: 'GSC' }),
    });
    assert.equal(res.status, 400);
  });
});

test.after(async () => {
  await closePool();
});
