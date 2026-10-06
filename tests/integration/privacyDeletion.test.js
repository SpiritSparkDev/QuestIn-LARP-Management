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
const { encryptFieldBlob: encAccount, decryptFieldBlob: decAccount } = await import('../../backend/accountFields.js');
const { encryptFieldBlob: encReg, decryptFieldBlob: decReg } = await import('../../backend/registrationFields.js');
const { runPrivacyDeletion, runDueAutoDeletions, privacyStatus } = await import('../../backend/privacy/repository.js');

async function makeUser(keep) {
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, email_verified, keep_data_consent, account_data_enc)
     VALUES ($1, 'P', 'D', (SELECT id FROM groups WHERE key = 'mitglied'), true, $2, $3) RETURNING id`,
    [`privacy-${crypto.randomUUID()}@example.com`, keep, encAccount({ address: 'Hauptstr. 1', phone: '123' })]
  );
  return rows[0].id;
}

async function makeEvent(mode, endedDaysAgo) {
  const config = { fields: { 'account:address': 'kontakt', 'registration:conTage': 'kontakt', 'account:phone': 'notfall' }, rules: { kontakt: { mode, days: 10 }, notfall: { mode, days: 10 } } };
  const { rows } = await query(
    `INSERT INTO events (name, event_date, privacy_deletion, ended_at)
     VALUES ('Privacy', '2026-01-01', $1, now() - make_interval(days => $2)) RETURNING id`,
    [JSON.stringify(config), endedDaysAgo]
  );
  return rows[0].id;
}

async function register(eventId, userId) {
  await query(
    `INSERT INTO registrations (user_id, event_id, con_role, status, registration_data_enc) VALUES ($1, $2, 'helfer', 'confirmed', $3)`,
    [userId, eventId, encReg({ conTage: 'Fr-So' })]
  );
}

async function accountOf(id) {
  const { rows } = await query('SELECT account_data_enc FROM users WHERE id = $1', [id]);
  return decAccount(rows[0].account_data_enc);
}

test('notify mode: nothing happens until an admin runs it; consent protects account data', async () => {
  const eventId = await makeEvent('notify', 20);
  const plain = await makeUser(false);
  const consenting = await makeUser(true);
  await register(eventId, plain);
  await register(eventId, consenting);

  await runDueAutoDeletions();
  assert.equal((await accountOf(plain)).address, 'Hauptstr. 1');

  assert.equal(await runPrivacyDeletion(eventId, 'kontakt'), true);
  const after = await accountOf(plain);
  assert.equal(after.address, null);
  assert.equal(after.phone, '123', 'other category untouched');
  assert.equal((await accountOf(consenting)).address, 'Hauptstr. 1');

  const { rows } = await query('SELECT registration_data_enc FROM registrations WHERE event_id = $1 AND user_id = $2', [eventId, consenting]);
  assert.equal(decReg(rows[0].registration_data_enc).conTage, null, 'registration fields are wiped regardless of consent');

  assert.equal(await runPrivacyDeletion(eventId, 'kontakt'), false, 'already done');
});

test('auto mode deletes due categories; not-yet-due ones stay', async () => {
  const dueEvent = await makeEvent('auto', 20);
  const futureEvent = await makeEvent('auto', 2);
  const a = await makeUser(false);
  const b = await makeUser(false);
  await register(dueEvent, a);
  await register(futureEvent, b);

  await runDueAutoDeletions();
  assert.equal((await accountOf(a)).address, null);
  assert.equal((await accountOf(b)).address, 'Hauptstr. 1');
  const { rows } = await query('SELECT * FROM events WHERE id = $1', [futureEvent]);
  assert.deepEqual(privacyStatus(rows[0]).map((s) => s.state), ['pending', 'pending']);
});

test.after(async () => {
  await closePool();
});
