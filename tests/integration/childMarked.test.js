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
const { decryptFieldBlob } = await import('../../backend/registrationFields.js');

const json = (cookie, method, body) => ({ method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });

test.beforeEach(async () => {
  await query('INSERT INTO app_settings (id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM app_settings)');
  await query('UPDATE app_settings SET children_enabled = true, children_count_capacity = false, children_age_limit = 16');
});
test.after(async () => {
  await query('UPDATE app_settings SET children_enabled = false, children_count_capacity = false, children_age_limit = 16');
  await query("DELETE FROM users WHERE email LIKE 'childmark-%'");
  await query("DELETE FROM events WHERE name = 'ChildMarked Con'");
  await closePool();
});

test('a person marked as a child keeps only names and child fields; the rest is ignored, not deleted', async () => {
  await withTestServer(async (port) => {
    const { rows } = await query(
      "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Eltern', 'Teil', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
      [`childmark-${crypto.randomUUID()}@example.com`]
    );
    const cookie = `session=${(await createSession(rows[0].id)).token}`;
    const base = `http://localhost:${port}`;
    const { rows: [event] } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('ChildMarked Con', '2027-09-01', true) RETURNING id");
    assert.equal((await fetch(`${base}/events/${event.id}/register`, json(cookie, 'POST', { conRole: 'sc' }))).status, 201);

    const created = await (await fetch(`${base}/managed-persons`, json(cookie, 'POST', { firstName: 'Klein', lastName: 'Kind', isChild: true, birthdate: '2020-01-01' }))).json();
    const read = async () => (await (await fetch(`${base}/managed-persons/${created.id}`, { headers: { Cookie: cookie } })).json());
    assert.equal((await read()).markedChild, true);
    assert.equal((await read()).birthdate ?? '', '', 'account fields are not stored for a marked child');

    // later edits of account fields are ignored too; names still change
    await fetch(`${base}/managed-persons/${created.id}`, json(cookie, 'PATCH', { birthdate: '2019-05-05', firstName: 'Klara' }));
    assert.equal((await read()).firstName, 'Klara');
    assert.equal((await read()).birthdate ?? '', '');

    // registration: child fields are stored, common registration fields are dropped
    const reg = await fetch(`${base}/managed-persons/${created.id}/events/${event.id}/register`, json(cookie, 'POST', {
      conRole: 'sc', otFields: { childVideo: true, photoOptOut: true },
    }));
    assert.equal(reg.status, 201);
    const stored = decryptFieldBlob((await query('SELECT registration_data_enc FROM registrations WHERE event_id = $1 AND user_id = $2', [event.id, created.id])).rows[0].registration_data_enc);
    assert.equal(stored.childVideo, true);
    assert.ok(!stored.photoOptOut);

    // unmarking brings the normal fields back
    await fetch(`${base}/managed-persons/${created.id}`, json(cookie, 'PATCH', { isChild: false, birthdate: '2019-05-05' }));
    const adult = await read();
    assert.equal(adult.markedChild, false);
    assert.equal(adult.birthdate, '2019-05-05');
  });
});
