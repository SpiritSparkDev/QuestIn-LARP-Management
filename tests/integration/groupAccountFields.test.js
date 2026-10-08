import { test, after } from 'node:test';
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
const { getAccountFieldSchema, setAccountFieldSchema } = await import('../../backend/accountFieldSchema/repository.js');
const { getGroupAccountFields, updateGroupAccountFields } = await import('../../backend/groupTree/accountFields.js');
const { listPendingReviews, resolveReview } = await import('../../backend/characterReviews/repository.js');
const { releasePerson } = await import('../../backend/managedPersons/repository.js');
const { encryptFieldBlob, decryptFieldBlob } = await import('../../backend/accountFields.js');

const makeUser = async (tag, parentId = null) => (await query(
  "INSERT INTO users (email, first_name, last_name, group_id, email_verified, group_parent_id) VALUES ($1, $2, 'Test', (SELECT id FROM groups WHERE key = 'mitglied'), true, $3) RETURNING id",
  [`gacc-${tag}-${crypto.randomUUID()}@example.com`, tag, parentId]
)).rows[0].id;

const originalSchema = await getAccountFieldSchema();
const manager = await makeUser('Manager');
const child = await makeUser('Child', manager);
const stranger = await makeUser('Stranger');
await setAccountFieldSchema([
  ...originalSchema.filter((f) => !['gaShared', 'gaShared2', 'gaPrivate'].includes(f.key)),
  { key: 'gaShared', label: 'Geteilt', type: 'text', required: false, groupManaged: true },
  { key: 'gaShared2', label: 'Geteilt 2', type: 'text', required: false, groupManaged: true },
  { key: 'gaPrivate', label: 'Privat', type: 'text', required: false },
]);
await query('UPDATE users SET account_data_enc = $2 WHERE id = $1', [child, encryptFieldBlob({ gaShared: 'alt', gaPrivate: 'geheim' })]);

after(async () => {
  await setAccountFieldSchema(originalSchema);
  await query('DELETE FROM users WHERE id = ANY($1)', [[child, manager, stranger]]);
  await closePool();
});

test('group manager edits only groupManaged account fields; owner can reject', async () => {
  assert.equal(await getGroupAccountFields(stranger, child), null);
  assert.equal(await updateGroupAccountFields(stranger, child, { gaShared: 'x' }), null);

  const view = await getGroupAccountFields(manager, child);
  assert.deepEqual(view.fields.map((f) => f.key), ['gaShared', 'gaShared2']);
  assert.equal(view.data.gaShared, 'alt');

  assert.deepEqual(await updateGroupAccountFields(manager, child, { gaShared: 'neu', gaPrivate: 'gehackt' }), { changed: 1 });
  const blob = decryptFieldBlob((await query('SELECT account_data_enc FROM users WHERE id = $1', [child])).rows[0].account_data_enc);
  assert.equal(blob.gaShared, 'neu');
  assert.equal(blob.gaPrivate, 'geheim');

  const pending = await listPendingReviews(child);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].account, true);
  await resolveReview(pending[0].id, child, 'reject');
  const after = decryptFieldBlob((await query('SELECT account_data_enc FROM users WHERE id = $1', [child])).rows[0].account_data_enc);
  assert.equal(after.gaShared, 'alt');
});

test('owner can accept some changed fields and reject the rest', async () => {
  await query('UPDATE users SET account_data_enc = $2 WHERE id = $1', [child, encryptFieldBlob({ gaShared: 'a1', gaShared2: 'b1' })]);
  await updateGroupAccountFields(manager, child, { gaShared: 'a2', gaShared2: 'b2' });
  const [review] = await listPendingReviews(child);
  assert.equal(review.changes.length, 2);
  const result = await resolveReview(review.id, child, 'accept', ['gaShared2']);
  assert.deepEqual(result.rejectedFields, ['gaShared2']);
  const blob = decryptFieldBlob((await query('SELECT account_data_enc FROM users WHERE id = $1', [child])).rows[0].account_data_enc);
  assert.equal(blob.gaShared, 'a2');
  assert.equal(blob.gaShared2, 'b1');
});

test('releasePerson detaches a managed person without deleting them, only for their manager', async () => {
  const person = await makeUser('Managed');
  await query('UPDATE users SET managed_by_user_id = $2 WHERE id = $1', [person, manager]);
  assert.equal(await releasePerson(person, stranger), false);
  assert.equal(await releasePerson(person, manager), true);
  const { rows } = await query('SELECT managed_by_user_id FROM users WHERE id = $1', [person]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].managed_by_user_id, null);
  await query('DELETE FROM users WHERE id = $1', [person]);
});
