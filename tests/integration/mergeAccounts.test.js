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
const { encryptFieldBlob, decryptFieldBlob } = await import('../../backend/accountFields.js');

const TAG = 'mergeacc';

async function makeUser(groupKey = 'mitglied', data = {}) {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified, account_data_enc) VALUES ($1, 'Dop', 'Pel', (SELECT id FROM groups WHERE key = $2), true, $3) RETURNING id",
    [`${TAG}-${crypto.randomUUID()}@example.com`, groupKey, encryptFieldBlob(data)]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

async function makeEvent(name) {
  return (await query("INSERT INTO events (name, event_date, is_active) VALUES ($1, '2027-08-01', true) RETURNING id", [name])).rows[0].id;
}

const post = (port, user, body) => fetch(`http://localhost:${port}/members/merge`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: user.cookie }, body: JSON.stringify(body),
});

test('merge moves registrations, payments, characters and fills empty fields; the duplicate is gone', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const keep = await makeUser('mitglied', { phone: '123' });
    const dup = await makeUser('mitglied', { phone: '999', address: 'Hauptstr. 1' });
    const eventId = await makeEvent('Merge Con');
    await query("INSERT INTO registrations (user_id, event_id, status, con_role) VALUES ($1, $2, 'confirmed', 'sc')", [dup.userId, eventId]);
    await query("INSERT INTO payments (user_id, event_id, method, amount_cents) VALUES ($1, $2, 'bank_transfer', 5000)", [dup.userId, eventId]);
    await query("INSERT INTO characters (user_id, name) VALUES ($1, 'Doppelgänger')", [dup.userId]).catch(async () => {
      await query("INSERT INTO characters (user_id, event_id, name) VALUES ($1, $2, 'Doppelgänger')", [dup.userId, eventId]);
    });

    const preview = await fetch(`http://localhost:${port}/members/merge-preview?keepId=${keep.userId}&dropId=${dup.userId}`, { headers: { Cookie: admin.cookie } });
    assert.equal(preview.status, 200);
    const info = await preview.json();
    assert.equal(info.registrations, 1);
    assert.deepEqual(info.conflicts, []);

    assert.equal((await post(port, keep, { keepId: keep.userId, dropId: dup.userId })).status, 403); // admin only
    assert.equal((await post(port, admin, { keepId: keep.userId, dropId: keep.userId })).status, 400);
    const res = await post(port, admin, { keepId: keep.userId, dropId: dup.userId });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

    assert.equal((await query('SELECT 1 FROM users WHERE id = $1', [dup.userId])).rowCount, 0);
    assert.equal((await query('SELECT 1 FROM registrations WHERE user_id = $1 AND event_id = $2', [keep.userId, eventId])).rowCount, 1);
    assert.equal((await query('SELECT amount_cents FROM payments WHERE user_id = $1 AND event_id = $2', [keep.userId, eventId])).rows[0].amount_cents, 5000);
    assert.equal((await query('SELECT count(*)::int AS n FROM characters WHERE user_id = $1', [keep.userId])).rows[0].n, 1);
    const data = decryptFieldBlob((await query('SELECT account_data_enc FROM users WHERE id = $1', [keep.userId])).rows[0].account_data_enc);
    assert.equal(data.phone, '123'); // the kept account's own value wins
    assert.equal(data.address, 'Hauptstr. 1'); // empty field filled
    assert.equal((await query("SELECT 1 FROM audit_log WHERE action = 'members.merged' AND subject_user_id = $1", [keep.userId])).rowCount, 1);
  });
});

test('merge is refused when both accounts are registered for the same event', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const keep = await makeUser();
    const dup = await makeUser();
    const eventId = await makeEvent('Merge Con');
    for (const u of [keep, dup]) await query("INSERT INTO registrations (user_id, event_id, status, con_role) VALUES ($1, $2, 'confirmed', 'sc')", [u.userId, eventId]);
    const res = await post(port, admin, { keepId: keep.userId, dropId: dup.userId });
    assert.equal(res.status, 409);
    assert.equal((await query('SELECT 1 FROM users WHERE id = $1', [dup.userId])).rowCount, 1);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE 'mergeacc-%'");
  await query("DELETE FROM events WHERE name = 'Merge Con'");
  await closePool();
});
