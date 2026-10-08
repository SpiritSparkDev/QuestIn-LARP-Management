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
const { createCharacter, updateCharacter } = await import('../../backend/characters/repository.js');
const { listPendingReviews, resolveReview } = await import('../../backend/characterReviews/repository.js');

const makeUser = async (tag) => (await query(
  "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, $2, 'Test', (SELECT id FROM groups WHERE key = 'mitglied'), true) RETURNING id",
  [`review-${tag}-${crypto.randomUUID()}@example.com`, tag]
)).rows[0].id;

const owner = await makeUser('Owner');
const other = await makeUser('Other');
after(async () => {
  await query('DELETE FROM users WHERE id = ANY($1)', [[owner, other]]);
  await closePool();
});

test('foreign change is queued for the owner; reject restores, own edit is not queued', async () => {
  const c = await createCharacter(owner, { name: 'Alt', data: {} });
  await updateCharacter(c.id, owner, { name: 'Selbst' }, { actorId: owner });
  assert.equal((await listPendingReviews(owner)).length, 0);

  await updateCharacter(c.id, owner, { name: 'Fremd', data: {} }, { actorId: other });
  const pending = await listPendingReviews(owner);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].changes.map((x) => [x.key, x.from, x.to]), [['name', 'Selbst', 'Fremd']]);

  assert.equal((await resolveReview(pending[0].id, other, 'reject')), null);
  await resolveReview(pending[0].id, owner, 'reject');
  assert.equal((await query('SELECT name FROM characters WHERE id = $1', [c.id])).rows[0].name, 'Selbst');
  assert.equal((await listPendingReviews(owner)).length, 0);
});
