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
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');

test.beforeEach(resetRateLimits);

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

test('flat groups: invitation, join codes, group-managed fields and leaving', async () => {
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
      const e = await makeUser('Emma');
      const f = await makeUser('Falk');
      const g = await makeUser('Gero');
      const h = await makeUser('Hanna');
      // Invitation: the answer is the same for unknown accounts.
      assert.equal((await call(a.cookie, 'POST', '/group-tree/invitations', { email: `${TAG}-niemand@example.com` })).status, 202);
      assert.equal((await call(a.cookie, 'POST', '/group-tree/invitations', { email: b.email })).status, 202);
      const incoming = (await (await call(b.cookie, 'GET', '/group-tree')).json()).incoming;
      assert.equal(incoming.length, 1);

      assert.equal((await call(b.cookie, 'POST', `/group-tree/invitations/${incoming[0].id}/accept`, {})).status, 200);
      // A legacy person managed by the member Bernd (members can't create new ones).
      const person = await makeUser('Kind', { isGuest: true, managedBy: b.userId });
      const { rows: charRows } = await query(
        "INSERT INTO characters (user_id, name, data) VALUES ($1, 'Heldin', $2) RETURNING id",
        [person.userId, JSON.stringify({ wunsch: 'alt', volk: 'Elf' })]
      );
      const characterId = charRows[0].id;
      const tree = await (await call(a.cookie, 'GET', '/group-tree')).json();
      assert.equal(tree.node.children[0].id, b.userId);
      assert.deepEqual(tree.node.children[0].persons.map((p) => p.id), [person.userId]);
      assert.deepEqual(tree.node.children[0].children, []);

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
        // Members see what their group manager entered.
        await query('UPDATE users SET group_data = $2 WHERE id = $1', [a.userId, JSON.stringify({ lager: 'Südwiese' })]);
        assert.deepEqual((await (await call(b.cookie, 'GET', '/group-tree')).json()).parent.groupData, { lager: 'Südwiese' });
      } finally {
        await query('DELETE FROM group_field_schema');
        if (oldGroupSchema.length) await query('INSERT INTO group_field_schema (schema) VALUES ($1)', [JSON.stringify(oldGroupSchema[0].schema)]);
      }

      // Only the "Gruppenverwaltung" fields are visible and editable for the manager above.
      const visible = await (await call(a.cookie, 'GET', `/group-tree/persons/${person.userId}/characters`)).json();
      assert.deepEqual(visible[0].fields.map((f) => f.key), ['wunsch']);
      assert.deepEqual(visible[0].data, { wunsch: 'alt' });
      assert.deepEqual(visible[0].nscFields, []);
      assert.equal((await call(c.cookie, 'GET', `/group-tree/persons/${person.userId}/characters`)).status, 404);
      const edit = await call(a.cookie, 'PUT', `/characters/${characterId}`, { name: 'Gehackt', data: { wunsch: 'neu', volk: 'Ork' } });
      assert.equal(edit.status, 200);
      const stored = (await query('SELECT name, data FROM characters WHERE id = $1', [characterId])).rows[0];
      assert.equal(stored.name, 'Heldin');
      assert.deepEqual(stored.data, { wunsch: 'neu', volk: 'Elf' });

      // NSC questionnaire: same rule, via PUT /characters/:id/nsc-data and its own schema.
      const { getNscProfileSchema, setNscProfileSchema } = await import('../../backend/nscSchema/repository.js');
      const oldNsc = await getNscProfileSchema();
    const hadNscRow = (await query('SELECT 1 FROM nsc_profile_schema LIMIT 1')).rows.length > 0;
      await setNscProfileSchema([
        { key: 'verwalter', label: 'Verwalter', type: 'text', required: false, groupManaged: true },
        { key: 'intern', label: 'Intern', type: 'text', required: false },
      ]);
      try {
        await query('UPDATE characters SET nsc_data = $2 WHERE id = $1', [characterId, JSON.stringify({ verwalter: 'a', intern: 'geheim' })]);
        const nscView = (await (await call(a.cookie, 'GET', `/group-tree/persons/${person.userId}/characters`)).json())[0];
        assert.deepEqual(nscView.nscFields.map((f) => f.key), ['verwalter']);
        assert.deepEqual(nscView.nscData, { verwalter: 'a' });
        const nscPut = await call(a.cookie, 'PUT', `/characters/${characterId}/nsc-data`, { data: { verwalter: 'b', intern: 'gehackt' } });
        assert.equal(nscPut.status, 200, JSON.stringify(await nscPut.clone().json()));
        const nscStored = (await query('SELECT nsc_data, data FROM characters WHERE id = $1', [characterId])).rows[0];
        assert.deepEqual(nscStored.nsc_data, { verwalter: 'b', intern: 'geheim' });
        assert.deepEqual(nscStored.data, { wunsch: 'neu', volk: 'Elf' });
        assert.equal((await call(c.cookie, 'PUT', `/characters/${characterId}/nsc-data`, { data: { verwalter: 'x' } })).status, 403);
      } finally {
        if (hadNscRow) await setNscProfileSchema(oldNsc);
      else await query('DELETE FROM nsc_profile_schema');
      }

      // Join codes: only a group manager makes them; validity and redemptions are validated.
      const create = (cookie, body) => call(cookie, 'POST', '/group-tree/join-codes', body);
      assert.equal((await create(b.cookie, { validity: '7d', maxRedemptions: 1 })).status, 403);
      assert.equal((await create(a.cookie, { validity: '2d', maxRedemptions: 1 })).status, 400);
      assert.equal((await create(a.cookie, { validity: '7d', maxRedemptions: 0 })).status, 400);
      assert.equal((await create(a.cookie, { validity: '7d', maxRedemptions: 1.5 })).status, 400);
      assert.equal((await call(c.cookie, 'POST', '/group-tree/join-code', {})).status, 404);
      const made = await (await create(a.cookie, { validity: '7d', maxRedemptions: 2 })).json();
      assert.match(made.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      const redeem = (cookie, code) => call(cookie, 'POST', '/group-tree/join-code/redeem', { code });
      assert.equal((await redeem(c.cookie, 'AAAA-BBBB-CCCC')).status, 404);
      const redeemed = await redeem(c.cookie, made.code.toLowerCase());
      assert.equal(redeemed.status, 200);
      assert.equal((await redeem(d.cookie, made.code)).status, 200);
      // Used up after two redemptions; the list shows what is left.
      assert.equal((await redeem(e.cookie, made.code)).status, 404);
      const listed = (await (await call(a.cookie, 'GET', '/group-tree')).json());
      assert.deepEqual(listed.node.children.map((ch) => ch.id).sort(), [b.userId, c.userId, d.userId].sort());
      assert.equal(listed.joinCodes[0].remaining, 0);
      assert.equal(listed.joinCodes[0].redemptions, 2);
      // A member can't join a second group, neither by code nor ...
      const other = await (await create(e.cookie, { validity: '1d', maxRedemptions: null })).json();
      assert.equal((await redeem(c.cookie, other.code)).status, 409);
      // ... a group manager (here Emma, who just made a code) can't join another.
      assert.equal((await redeem(e.cookie, made.code)).status, 404);
      const unlimited = await (await create(a.cookie, { validity: 'unlimited', maxRedemptions: null })).json();
      assert.equal((await redeem(e.cookie, unlimited.code)).status, 409);
      assert.equal((await redeem(f.cookie, unlimited.code)).status, 200);
      // Expired codes and deleted codes don't work.
      const shortLived = await (await create(a.cookie, { validity: '1d', maxRedemptions: null })).json();
      await query("UPDATE group_join_codes SET expires_at = now() - interval '1 minute' WHERE id = $1", [shortLived.id]);
      assert.equal((await redeem(g.cookie, shortLived.code)).status, 404);
      assert.equal((await call(a.cookie, 'DELETE', `/group-tree/join-codes/${unlimited.id}`)).status, 200);
      assert.equal((await redeem(g.cookie, unlimited.code)).status, 404);
      assert.equal((await call(b.cookie, 'DELETE', `/group-tree/join-codes/${shortLived.id}`)).status, 403);
      resetRateLimits();
      // Concurrent redemptions of a one-time code: exactly one wins.
      const once = await (await create(a.cookie, { validity: '3d', maxRedemptions: 1 })).json();
      const results = await Promise.all([redeem(g.cookie, once.code), redeem(h.cookie, once.code)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);

      // The parent may handle event registrations of persons below them -- but only sees their name.
      assert.equal((await call(a.cookie, 'GET', `/managed-persons/${person.userId}/registrations`)).status, 200);
      const seen = await (await call(a.cookie, 'GET', `/managed-persons/${person.userId}`)).json();
      assert.equal(seen.email, null);
      assert.equal((await call(d.cookie, 'GET', `/managed-persons/${person.userId}/registrations`)).status, 404);
      // ...and the member themselves.
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
    assert.equal((await post(member.cookie, '/group-tree/join-codes', { validity: '7d', maxRedemptions: 1 })).status, 403);
    assert.equal((await post(member.cookie, '/managed-persons', { firstName: 'X' })).status, 403);
    assert.equal((await fetch(`${base}/managed-persons/search?q=abc`, { headers: { Cookie: member.cookie } })).status, 403);
    assert.equal((await fetch(`${base}/account`, { headers: { Cookie: member.cookie } }).then((r) => r.json())).groupMemberOnly, true);
  });
});

test('nobody joins a second group: members, managers, invitations and codes', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const call = (cookie, method, path, body) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const boss = await makeUser('Boss');
    const other = await makeUser('Zweitboss');
    const withPerson = await makeUser('Verwalter');
    await makeUser('Schutzbefohlene', { isGuest: true, managedBy: withPerson.userId });
    const fresh = await makeUser('Frisch');
    const code = (await (await call(boss.cookie, 'POST', '/group-tree/join-codes', { validity: '1m', maxRedemptions: null })).json()).code;

    // A manager (has a person) is refused with a clear message, by code and by invitation.
    const refused = await call(withPerson.cookie, 'POST', '/group-tree/join-code/redeem', { code });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /verwaltest bereits eine eigene Gruppe/);
    // Not even sent in the first place; one that predates the person's own group is refused on accept.
    await call(boss.cookie, 'POST', '/group-tree/invitations', { email: withPerson.email });
    assert.equal((await query('SELECT 1 FROM group_invitations WHERE child_user_id = $1', [withPerson.userId])).rowCount, 0);
    await query('INSERT INTO group_invitations (parent_user_id, child_user_id) VALUES ($1, $2)', [boss.userId, withPerson.userId]);
    const invite = (await (await call(withPerson.cookie, 'GET', '/group-tree')).json());
    assert.equal(invite.canJoinGroup, false);
    const { rows: [inv] } = await query('SELECT id FROM group_invitations WHERE child_user_id = $1', [withPerson.userId]);
    const acc = await call(withPerson.cookie, 'POST', `/group-tree/invitations/${inv.id}/accept`, {});
    assert.equal(acc.status, 409);
    assert.match((await acc.json()).error, /verwaltest bereits eine eigene Gruppe/);

    // Someone with a group name is a manager too.
    await call(other.cookie, 'PATCH', '/group-tree/name', { name: 'Eigene Bande' });
    assert.equal((await call(other.cookie, 'POST', '/group-tree/join-code/redeem', { code })).status, 409);

    // A fresh person joins once; the second try (invitation or code) fails clearly.
    assert.equal((await (await call(fresh.cookie, 'GET', '/group-tree')).json()).canJoinGroup, true);
    assert.equal((await call(fresh.cookie, 'POST', '/group-tree/join-code/redeem', { code })).status, 200);
    assert.equal((await (await call(fresh.cookie, 'GET', '/group-tree')).json()).canJoinGroup, false);
    const again = await call(fresh.cookie, 'POST', '/group-tree/join-code/redeem', { code });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /bereits Mitglied einer Gruppe/);
    await call(other.cookie, 'POST', '/group-tree/invitations', { email: fresh.email });
    assert.equal((await (await call(fresh.cookie, 'GET', '/group-tree')).json()).incoming.length, 0);
    // An invitation that existed before joining is cleaned up and can't be accepted later.
    const { rows: [stale] } = await query('INSERT INTO group_invitations (parent_user_id, child_user_id) VALUES ($1, $2) RETURNING id', [other.userId, fresh.userId]);
    assert.equal((await call(fresh.cookie, 'POST', `/group-tree/invitations/${stale.id}/accept`, {})).status, 409);
    const { rows: [parentRow] } = await query('SELECT group_parent_id FROM users WHERE id = $1', [fresh.userId]);
    assert.equal(parentRow.group_parent_id, boss.userId);
  });
});

test.after(async () => {
  await query('DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${TAG}-%@example.com`]);
  await query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-%@example.com`]);
  await closePool();
});
