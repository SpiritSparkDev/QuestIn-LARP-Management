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

const TAG = `claim${crypto.randomUUID().slice(0, 6)}`;

async function makeUser({ firstName, lastName, isGuest = false, email = null, managedBy = null }) {
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, is_guest, email_verified, managed_by_user_id)
     VALUES ($1, $2, $3, (SELECT id FROM groups WHERE key = 'mitglied'), $4, $4 = false, $5) RETURNING id`,
    [email ?? `${TAG}-${crypto.randomUUID()}@example.com`, firstName, lastName, isGuest, managedBy]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

test('a group owner can search and claim unmanaged guest accounts -- and nothing else', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const owner = await makeUser({ firstName: 'Owner', lastName: TAG });
    const other = await makeUser({ firstName: 'Other', lastName: TAG });
    const guest = await makeUser({ firstName: 'Gastfrau', lastName: `${TAG}Muster`, isGuest: true, email: `gast.${TAG}@example.com` });
    const managed = await makeUser({ firstName: 'Schonvergeben', lastName: `${TAG}Muster`, isGuest: true, managedBy: other.userId });
    const fullAccount = await makeUser({ firstName: 'Vollkonto', lastName: `${TAG}Muster` });
    const headers = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });
    const search = (term) => fetch(`${base}/managed-persons/search?q=${encodeURIComponent(term)}`, { headers: headers(owner.cookie) });

    assert.equal((await search('ab')).status, 400);

    // Only the free guest account is found -- not the managed one, not the full account.
    const found = await (await search(`${TAG}Muster`)).json();
    assert.deepEqual(found.map((p) => p.id), [guest.userId]);
    assert.equal(found[0].emailHint, `g***@example.com`);
    assert.equal(JSON.stringify(found).includes(`gast.${TAG}`), false);

    // IT names: the guest is also found by a character name.
    await query("INSERT INTO characters (user_id, class, name) VALUES ($1, 'sc', $2)", [guest.userId, `Ritter${TAG}`]);
    assert.deepEqual((await (await search(`ritter${TAG}`)).json()).map((p) => p.id), [guest.userId]);

    // An e-mail only matches when typed in full.
    assert.deepEqual(await (await search(`gast.${TAG}`)).json(), []);
    assert.deepEqual((await (await search(`gast.${TAG}@example.com`)).json()).map((p) => p.id), [guest.userId]);

    // Full accounts and already managed persons can't be claimed.
    for (const id of [fullAccount.userId, managed.userId, owner.userId]) {
      const res = await fetch(`${base}/managed-persons/${id}/claim`, { method: 'POST', headers: headers(owner.cookie), body: '{}' });
      assert.equal(res.status, 404);
    }

    const claimed = await fetch(`${base}/managed-persons/${guest.userId}/claim`, { method: 'POST', headers: headers(owner.cookie), body: '{}' });
    assert.equal(claimed.status, 200);
    const list = await (await fetch(`${base}/managed-persons`, { headers: headers(owner.cookie) })).json();
    assert.deepEqual(list.map((p) => p.id), [guest.userId]);

    // Once claimed, nobody else can take the person.
    const again = await fetch(`${base}/managed-persons/${guest.userId}/claim`, { method: 'POST', headers: headers(other.cookie), body: '{}' });
    assert.equal(again.status, 404);
  });
});

test.after(async () => {
  await query("DELETE FROM users WHERE email LIKE $1", [`${TAG}-%@example.com`]);
  await query("DELETE FROM users WHERE email LIKE $1", [`gast.${TAG}@example.com`]);
  await closePool();
});
