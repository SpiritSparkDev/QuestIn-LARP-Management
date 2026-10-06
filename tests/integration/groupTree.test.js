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

const TAG = `gtree${crypto.randomUUID().slice(0, 6)}`;

async function makeUser(firstName, { isGuest = false, managedBy = null } = {}) {
  const email = `${TAG}-${firstName.toLowerCase()}@example.com`;
  const { rows } = await query(
    `INSERT INTO users (email, first_name, last_name, group_id, is_guest, email_verified, managed_by_user_id)
     VALUES ($1, $2, $3, (SELECT id FROM groups WHERE key = 'mitglied'), $4, $4 = false, $5) RETURNING id`,
    [email, firstName, TAG, isGuest, managedBy]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, email, cookie: `session=${session.token}` };
}

test('nested groups: invitation, join code, group-managed fields, cycles and leaving', async () => {
  const { rows: oldSchemaRows } = await query('SELECT id, schema FROM sc_character_schema LIMIT 1');
  const schema = [
    { key: 'wunsch', label: 'Wunsch', type: 'text', required: false, groupManaged: true },
    { key: 'volk', label: 'Volk', type: 'text', required: false },
  ];
  if (oldSchemaRows.length) await query('UPDATE sc_character_schema SET schema = $1', [JSON.stringify(schema)]);
  else await query('INSERT INTO sc_character_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  try {
    await withTestServer(async (port) => {
      const base = `http://localhost:${port}`;
      const headers = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });
      const call = (cookie, method, path, body) => fetch(`${base}${path}`, { method, headers: headers(cookie), body: body === undefined ? undefined : JSON.stringify(body) });
      const a = await makeUser('Anna');
      const b = await makeUser('Bernd');
      const c = await makeUser('Carla');
      const d = await makeUser('Dora');
      const person = await makeUser('Kind', { isGuest: true, managedBy: b.userId });
      const { rows: charRows } = await query(
        "INSERT INTO characters (user_id, class, name, data) VALUES ($1, 'sc', 'Heldin', $2) RETURNING id",
        [person.userId, JSON.stringify({ wunsch: 'alt', volk: 'Elf' })]
      );
      const characterId = charRows[0].id;

      // Invitation: the answer is the same for unknown accounts.
      assert.equal((await call(a.cookie, 'POST', '/group-tree/invitations', { email: `${TAG}-niemand@example.com` })).status, 202);
      assert.equal((await call(a.cookie, 'POST', '/group-tree/invitations', { email: b.email })).status, 202);
      const incoming = (await (await call(b.cookie, 'GET', '/group-tree')).json()).incoming;
      assert.equal(incoming.length, 1);

      // Not an ancestor yet.
      assert.equal((await call(a.cookie, 'GET', `/group-tree/persons/${person.userId}/characters`)).status, 404);
      assert.equal((await call(a.cookie, 'PUT', `/characters/${characterId}`, { data: { wunsch: 'x' } })).status, 403);

      assert.equal((await call(b.cookie, 'POST', `/group-tree/invitations/${incoming[0].id}/accept`, {})).status, 200);
      const tree = await (await call(a.cookie, 'GET', '/group-tree')).json();
      assert.equal(tree.node.children[0].id, b.userId);
      assert.deepEqual(tree.node.children[0].persons.map((p) => p.id), [person.userId]);

      // A group name shows up in the tree above and can't be abused for oversized input.
      // Bernd joined a group, so he is a plain member now and may not manage anything.
      assert.equal((await call(b.cookie, 'PATCH', '/group-tree/name', { name: 'Drachenbande' })).status, 403);
      assert.equal((await call(a.cookie, 'PATCH', '/group-tree/name', { name: 'x'.repeat(61) })).status, 400);
      await query('UPDATE users SET group_name = $2 WHERE id = $1', [b.userId, 'Drachenbande']);
      const named = await (await call(a.cookie, 'GET', '/group-tree')).json();
      assert.ok(named.node.children[0].name.startsWith('Drachenbande ('));
      assert.equal((await (await call(b.cookie, 'GET', '/group-tree')).json()).groupName, 'Drachenbande');

      // Group fields defined by the admin are stored per group; unknown keys are ignored.
      const { rows: oldGroupSchema } = await query('SELECT schema FROM group_field_schema LIMIT 1');
      await query('DELETE FROM group_field_schema');
      await query('INSERT INTO group_field_schema (schema) VALUES ($1)', [JSON.stringify([{ key: 'lager', label: 'Lager', type: 'text', required: false }])]);
      try {
        assert.equal((await call(b.cookie, 'PATCH', '/group-tree/fields', { lager: 'Nordwiese' })).status, 403);
        await query('UPDATE users SET group_data = $2 WHERE id = $1', [b.userId, JSON.stringify({ lager: 'Nordwiese' })]);
        // The manager above sees the values of the subgroup.
        assert.deepEqual((await (await call(a.cookie, 'GET', '/group-tree')).json()).node.children[0].groupData, { lager: 'Nordwiese' });
      } finally {
        await query('DELETE FROM group_field_schema');
        if (oldGroupSchema.length) await query('INSERT INTO group_field_schema (schema) VALUES ($1)', [JSON.stringify(oldGroupSchema[0].schema)]);
      }

      // Only the "Gruppenverwaltung" fields are visible and editable for the manager above.
      const visible = await (await call(a.cookie, 'GET', `/group-tree/persons/${person.userId}/characters`)).json();
      assert.deepEqual(visible[0].fields.map((f) => f.key), ['wunsch']);
      assert.deepEqual(visible[0].data, { wunsch: 'alt' });
      assert.equal((await call(c.cookie, 'GET', `/group-tree/persons/${person.userId}/characters`)).status, 404);
      const edit = await call(a.cookie, 'PUT', `/characters/${characterId}`, { name: 'Gehackt', data: { wunsch: 'neu', volk: 'Ork' } });
      assert.equal(edit.status, 200);
      const stored = (await query('SELECT name, data FROM characters WHERE id = $1', [characterId])).rows[0];
      assert.equal(stored.name, 'Heldin');
      assert.deepEqual(stored.data, { wunsch: 'neu', volk: 'Elf' });

      // No cycles: Bernd cannot invite his own ancestor.
      await call(b.cookie, 'POST', '/group-tree/invitations', { email: a.email });
      assert.equal((await (await call(a.cookie, 'GET', '/group-tree')).json()).incoming.length, 0);

      // Join code: Carla creates it, Anna enters it, no further confirmation.
      const { code } = await (await call(c.cookie, 'POST', '/group-tree/join-code', {})).json();
      assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.equal((await call(a.cookie, 'POST', '/group-tree/join-code/redeem', { code: 'AAAA-BBBB-CCCC' })).status, 404);
      const redeemed = await call(a.cookie, 'POST', '/group-tree/join-code/redeem', { code: code.toLowerCase() });
      assert.equal(redeemed.status, 200);
      assert.deepEqual((await redeemed.json()).node.children.map((ch) => ch.id).sort(), [b.userId, c.userId].sort());
      assert.equal((await call(d.cookie, 'POST', '/group-tree/join-code/redeem', { code })).status, 404);

      // The parent may handle event registrations of persons below them -- but only sees their name.
      assert.equal((await call(a.cookie, 'GET', `/managed-persons/${person.userId}/registrations`)).status, 200);
      const seen = await (await call(a.cookie, 'GET', `/managed-persons/${person.userId}`)).json();
      assert.equal(seen.email, null);
      assert.equal((await call(d.cookie, 'GET', `/managed-persons/${person.userId}/registrations`)).status, 404);
      // ...and the subgroup's manager themselves.
      assert.equal((await call(a.cookie, 'GET', `/managed-persons/${b.userId}/registrations`)).status, 200);
      assert.equal((await call(d.cookie, 'GET', `/managed-persons/${b.userId}/registrations`)).status, 404);
      // Leaving ends the access.
      assert.equal((await call(b.cookie, 'POST', '/group-tree/leave', {})).status, 200);
      assert.equal((await call(a.cookie, 'PUT', `/characters/${characterId}`, { data: { wunsch: 'zu spät' } })).status, 403);
      assert.equal((await call(a.cookie, 'GET', `/managed-persons/${person.userId}/registrations`)).status, 404);
      // The parent can also remove a child.
      assert.equal((await call(a.cookie, 'DELETE', `/group-tree/children/${c.userId}`)).status, 200);
    });
  } finally {
    if (oldSchemaRows.length) await query('UPDATE sc_character_schema SET schema = $1', [JSON.stringify(oldSchemaRows[0].schema)]);
    else await query('DELETE FROM sc_character_schema');
  }
});

test('e-mail invitation without account: sign-up link puts the new account into the group', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const post = (cookie, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie ?? '' }, body: JSON.stringify(body) });
    const a = await makeUser('Emil');
    const email = `${TAG}-neu@example.com`;
    assert.equal((await post(a.cookie, '/group-tree/invitations', { email })).status, 202);
    const out = (await (await fetch(`${base}/group-tree`, { headers: { Cookie: a.cookie } })).json()).outgoing;
    assert.equal(out[0].name, email);
    const { rows } = await query('SELECT token FROM group_invitations WHERE parent_user_id = $1', [a.userId]);
    const token = rows[0].token;
    assert.equal((await fetch(`${base}/auth/group-invite/info?token=${token}`)).status, 200);
    assert.equal((await fetch(`${base}/auth/group-invite/info?token=nope`)).status, 400);
    assert.equal((await post(null, '/auth/group-invite/redeem', { token, password: 'passwort123' })).status, 400);
    const res = await post(null, '/auth/group-invite/redeem', { token, password: 'passwort123', firstName: 'Neu', lastName: TAG });
    assert.equal(res.status, 200);
    const { rows: u } = await query('SELECT group_parent_id, email_verified FROM users WHERE email = $1', [email]);
    assert.equal(u[0].group_parent_id, a.userId);
    assert.equal(u[0].email_verified, true);
    assert.equal((await post(null, '/auth/group-invite/redeem', { token, password: 'passwort123', firstName: 'Neu', lastName: TAG })).status, 400);

    // A plain member can't manage anything in the group.
    const { rows: m } = await query('SELECT id FROM users WHERE email = $1', [email]);
    const member = { cookie: `session=${(await createSession(m[0].id)).token}` };
    assert.equal((await post(member.cookie, '/group-tree/invitations', { email: `${TAG}-x@example.com` })).status, 403);
    assert.equal((await post(member.cookie, '/group-tree/join-code', {})).status, 403);
    assert.equal((await post(member.cookie, '/managed-persons', { firstName: 'X' })).status, 403);
    assert.equal((await fetch(`${base}/managed-persons/search?q=abc`, { headers: { Cookie: member.cookie } })).status, 403);
    assert.equal((await fetch(`${base}/account`, { headers: { Cookie: member.cookie } }).then((r) => r.json())).groupMemberOnly, true);
  });
});

test.after(async () => {
  await query('DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${TAG}-%@example.com`]);
  await query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-%@example.com`]);
  await closePool();
});
