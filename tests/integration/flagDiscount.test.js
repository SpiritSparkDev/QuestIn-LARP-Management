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

async function makeUser(groupKey) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Rabatt', 'Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`fd-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('a Sonderrolle discount lowers the amount due at registration and when the role is added later (unpaid only)', async () => {
  await withTestServer(async (port) => {
    const { rows } = await query(
      `INSERT INTO events (name, event_date, is_active, flags, flag_settings, pricing) VALUES ('Rabatt Con', '2099-08-01', true, $1, $2, $3) RETURNING id`,
      [['Ersthelfer', 'GSC'], JSON.stringify({ Ersthelfer: { abbr: 'ERS', discount: { type: 'percent', value: 25 } }, GSC: { discount: { type: 'free' } } }),
        JSON.stringify({ groups: ['Erw'], tiers: [{ name: 'Normal', until: null, conPayer: false, amounts: { Erw: 10000 } }] })]
    );
    const eventId = rows[0].id;
    const post = (cookie, path, body, method = 'POST') => fetch(`http://localhost:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const due = async (userId) => (await query('SELECT amount_due_cents FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0].amount_due_cents;

    const a = await makeUser('mitglied');
    assert.equal((await post(a.cookie, `/events/${eventId}/register`, { conRole: 'helfer', priceGroup: 'Erw', flags: ['Ersthelfer'] })).status, 201);
    assert.equal(await due(a.userId), 7500);

    const b = await makeUser('mitglied');
    assert.equal((await post(b.cookie, `/events/${eventId}/register`, { conRole: 'helfer', priceGroup: 'Erw', flags: ['GSC'] })).status, 201);
    assert.equal(await due(b.userId), 0);

    // Adding the role later moves the amount; once paid it stays.
    const c = await makeUser('mitglied');
    await post(c.cookie, `/events/${eventId}/register`, { conRole: 'helfer', priceGroup: 'Erw' });
    assert.equal(await due(c.userId), 10000);
    const { cookie: adminCookie } = await makeUser('admin');
    assert.equal((await post(adminCookie, `/events/${eventId}/registrations/${c.userId}/ot-fields`, { flags: ['Ersthelfer'] }, 'PUT')).status, 200);
    assert.equal(await due(c.userId), 7500);
  });
});

test.after(closePool);
