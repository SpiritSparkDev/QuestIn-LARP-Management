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
const { ageInYears, isChildForFields } = await import('../../backend/childFieldSchema/repository.js');
const { decryptFieldBlob } = await import('../../backend/registrationFields.js');

async function makeUser(groupKey = 'mitglied') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Eltern', 'Teil', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`childfld-${crypto.randomUUID()}@example.com`, groupKey]
  );
  return { userId: rows[0].id, cookie: `session=${(await createSession(rows[0].id)).token}` };
}

const json = (cookie, method, body) => ({ method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const yearsAgo = (n, days = 0) => new Date(Date.now() - (n * 365.25 + days) * 86400000).toISOString().slice(0, 10);

test.beforeEach(async () => {
  await query('INSERT INTO app_settings (id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM app_settings)');
  await query('UPDATE app_settings SET children_enabled = true, children_count_capacity = false, children_age_limit = 16');
});
test.after(async () => {
  await query('UPDATE app_settings SET children_enabled = false, children_count_capacity = false, children_age_limit = 16');
  await query("DELETE FROM users WHERE email LIKE 'childfld-%'");
  await query("DELETE FROM events WHERE name = 'ChildFields Con'");
  await closePool();
});

test('ageInYears counts whole years and ignores missing or unreadable dates', () => {
  const today = new Date('2026-10-18T12:00:00Z');
  assert.equal(ageInYears('2010-10-18', today), 16);
  assert.equal(ageInYears('2010-10-19', today), 15);
  assert.equal(ageInYears('', today), null);
  assert.equal(ageInYears(null, today), null);
  assert.equal(ageInYears('kein datum', today), null);
});

test('the child schema ships with photo and video fields; only admins change it; keys may not clash with the registration fields', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const member = await makeUser();
    const base = `http://localhost:${port}/child-schema`;
    const defaults = await (await fetch(base, { headers: { Cookie: member.cookie } })).json();
    assert.deepEqual(defaults.map((f) => f.key), ['childPhotoInternal', 'childPhotoPublic', 'childVideo']);

    assert.equal((await fetch(base, json(member.cookie, 'PUT', { schema: [] }))).status, 403);
    const clash = await fetch(base, json(admin.cookie, 'PUT', { schema: [{ key: 'photoOptOut', label: 'x', type: 'boolean' }] }));
    assert.equal(clash.status, 400); // photoOptOut is a registration field already
    const saved = await fetch(base, json(admin.cookie, 'PUT', { schema: [...defaults, { key: 'childAllergy', label: 'Allergien des Kindes', type: 'text' }] }));
    assert.equal(saved.status, 200);
    assert.equal((await (await fetch(base, { headers: { Cookie: member.cookie } })).json()).length, 4);
    await fetch(base, json(admin.cookie, 'PUT', { schema: defaults })); // back to the default
  });
});

test('who counts as a child: the mark, or under the age limit; the limit is an admin setting; off with the add-on off', async () => {
  await withTestServer(async (port) => {
    const admin = await makeUser('admin');
    const guardian = await makeUser();
    const create = async (extra) => (await (await fetch(`http://localhost:${port}/managed-persons`, json(guardian.cookie, 'POST', { firstName: 'Klein', lastName: 'Kind', ...extra }))).json()).id;
    const marked = await create({ isChild: true });
    const young = await create({ birthdate: yearsAgo(12) });
    const sixteen = await create({ birthdate: yearsAgo(16, 30) });
    const adult = await create({ birthdate: yearsAgo(30) });
    const noDate = await create({});

    const flags = async () => Object.fromEntries(await Promise.all(Object.entries({ marked, young, sixteen, adult, noDate }).map(async ([k, id]) => [k, await isChildForFields(id)])));
    assert.deepEqual(await flags(), { marked: true, young: true, sixteen: false, adult: false, noDate: false });

    // the admin raises the limit: a 16-year-old now counts
    assert.equal((await fetch(`http://localhost:${port}/app-settings`, json(admin.cookie, 'PUT', { childrenAgeLimit: 18 }))).status, 200);
    assert.equal((await flags()).sixteen, true);
    assert.equal((await fetch(`http://localhost:${port}/app-settings`, json(admin.cookie, 'PUT', { childrenAgeLimit: 0 }))).status, 400);
    assert.equal((await fetch(`http://localhost:${port}/app-settings`, json(admin.cookie, 'PUT', { childrenAgeLimit: 'x' }))).status, 400);

    await query('UPDATE app_settings SET children_enabled = false');
    assert.equal((await flags()).marked, false);

    // what the page reads
    await query('UPDATE app_settings SET children_enabled = true, children_age_limit = 16');
    const person = await (await fetch(`http://localhost:${port}/managed-persons/${young}`, { headers: { Cookie: guardian.cookie } })).json();
    assert.equal(person.childFields, true);
  });
});

test('registering a child stores the child fields per child; for an adult they are ignored', async () => {
  await withTestServer(async (port) => {
    const guardian = await makeUser();
    const { rows: [event] } = await query("INSERT INTO events (name, event_date, is_active) VALUES ('ChildFields Con', '2027-09-01', true) RETURNING id");
    const create = async (extra) => (await (await fetch(`http://localhost:${port}/managed-persons`, json(guardian.cookie, 'POST', { firstName: 'Klein', lastName: 'Kind', ...extra }))).json()).id;
    const child = await create({ birthdate: yearsAgo(9) });
    const adultPerson = await create({ birthdate: yearsAgo(40) });

    // the guardian has to be registered first
    assert.equal((await fetch(`http://localhost:${port}/events/${event.id}/register`, json(guardian.cookie, 'POST', { conRole: 'sc' }))).status, 201);
    const register = (id) => fetch(`http://localhost:${port}/managed-persons/${id}/events/${event.id}/register`, json(guardian.cookie, 'POST', {
      conRole: 'sc', otFields: { childPhotoInternal: true, childPhotoPublic: false, childVideo: true },
    }));
    assert.equal((await register(child)).status, 201);
    assert.equal((await register(adultPerson)).status, 201);

    const stored = async (id) => decryptFieldBlob((await query('SELECT registration_data_enc FROM registrations WHERE event_id = $1 AND user_id = $2', [event.id, id])).rows[0].registration_data_enc);
    const childData = await stored(child);
    assert.equal(childData.childPhotoInternal, true);
    assert.equal(childData.childVideo, true);
    assert.equal((await stored(adultPerson)).childVideo, undefined);

    // the guardian can change them later (same endpoint as the other registration fields)
    const edit = await fetch(`http://localhost:${port}/events/${event.id}/registrations/${child}/ot-fields`, json(guardian.cookie, 'PUT', { childVideo: false }));
    assert.equal(edit.status, 200);
    assert.equal((await stored(child)).childVideo, false);
  });
});
