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

test('after the deadline, characters of consenting accounts keep their fields; the others lose them', async () => {
  const config = { fields: { 'sc:volk': 'charakter' }, rules: { charakter: { mode: 'auto', days: 10 } } };
  const { rows: eventRows } = await query(
    "INSERT INTO events (name, event_date, privacy_deletion, ended_at) VALUES ('Privacy chars', '2026-01-01', $1, now() - interval '20 days') RETURNING id",
    [JSON.stringify(config)]
  );
  const eventId = eventRows[0].id;
  const plain = await makeUser(false);
  const consenting = await makeUser(true);
  const characterOf = {};
  for (const [name, userId] of [['plain', plain], ['consenting', consenting]]) {
    const { rows } = await query("INSERT INTO characters (user_id, name, data) VALUES ($1, $2, $3) RETURNING id", [userId, name, JSON.stringify({ volk: 'Elf', beruf: 'Schmied' })]);
    characterOf[name] = rows[0].id;
    await query("INSERT INTO registrations (user_id, event_id, con_role, status, character_id) VALUES ($1, $2, 'sc', 'confirmed', $3)", [userId, eventId, rows[0].id]);
  }

  await runDueAutoDeletions();
  const data = async (id) => (await query('SELECT data FROM characters WHERE id = $1', [id])).rows[0].data;
  assert.deepEqual(await data(characterOf.plain), { beruf: 'Schmied' });
  assert.deepEqual(await data(characterOf.consenting), { volk: 'Elf', beruf: 'Schmied' });
});

test('nsc scope wipes characters.nsc_data (sc or nsc character of the event) and the Springer data; sc scope leaves nsc_data alone', async () => {
  const config = { fields: { 'nsc:kampf': 'charakter', 'sc:volk': 'charakter' }, rules: { charakter: { mode: 'auto', days: 10 } } };
  const { rows: eventRows } = await query(
    "INSERT INTO events (name, event_date, privacy_deletion, ended_at) VALUES ('Privacy nsc', '2026-01-01', $1, now() - interval '20 days') RETURNING id",
    [JSON.stringify(config)]
  );
  const eventId = eventRows[0].id;
  const plain = await makeUser(false);
  const consenting = await makeUser(true);
  const springer = await makeUser(false);
  const mkChar = async (userId, name) => (await query(
    "INSERT INTO characters (user_id, name, data, nsc_data) VALUES ($1, $2, $3, $4) RETURNING id",
    [userId, name, JSON.stringify({ volk: 'Elf' }), JSON.stringify({ kampf: 'ja', rest: 'bleibt' })])).rows[0].id;
  const asNsc = await mkChar(plain, 'asNsc');
  const keep = await mkChar(consenting, 'keep');
  await query("INSERT INTO registrations (user_id, event_id, con_role, status, character_id) VALUES ($1, $2, 'nsc', 'confirmed', $3)", [plain, eventId, asNsc]);
  await query("INSERT INTO registrations (user_id, event_id, con_role, status, character_id) VALUES ($1, $2, 'nsc', 'confirmed', $3)", [consenting, eventId, keep]);
  await query("INSERT INTO registrations (user_id, event_id, con_role, status, nsc_data) VALUES ($1, $2, 'nsc', 'confirmed', $3)", [springer, eventId, JSON.stringify({ kampf: 'ja', rest: 'bleibt' })]);
  // a character linked only via nsc_character_id of an SC registration
  const linker = await makeUser(false);
  const asScWithNscLink = await mkChar(linker, 'link');
  await query("INSERT INTO registrations (user_id, event_id, con_role, status, nsc_character_id) VALUES ($1, $2, 'sc', 'confirmed', $3)", [linker, eventId, asScWithNscLink]);

  await runDueAutoDeletions();
  const row = async (id) => (await query('SELECT data, nsc_data FROM characters WHERE id = $1', [id])).rows[0];
  assert.deepEqual(await row(asNsc), { data: {}, nsc_data: { rest: 'bleibt' } });
  assert.deepEqual(await row(asScWithNscLink), { data: { volk: 'Elf' }, nsc_data: { rest: 'bleibt' } });
  assert.deepEqual(await row(keep), { data: { volk: 'Elf' }, nsc_data: { kampf: 'ja', rest: 'bleibt' } });
  const { rows } = await query('SELECT nsc_data FROM registrations WHERE user_id = $1 AND event_id = $2', [springer, eventId]);
  assert.deepEqual(rows[0].nsc_data, { rest: 'bleibt' });
});

test.after(async () => {
  await closePool();
});
