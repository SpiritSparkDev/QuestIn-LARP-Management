// "Charakter aus QuestIn-Konto übernehmen": reading the hub's Charakter-Mappe
// server side and mapping it onto this instance's character schema.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.APP_MODE;

const { query } = await import('../../backend/db.js');
const { fetchHubCharacters } = await import('../../backend/hubCharacters/routes.js');
const { mapHubCharacter } = await import('../../backend/hubCharacters/mapping.js');

const ENV = ['HUB_ISSUER', 'HUB_CLIENT_ID', 'HUB_CLIENT_SECRET'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
after(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function user({ hubSub } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, group_id, first_name, last_name, nickname, email_verified)
     VALUES ($1, NULL, (SELECT id FROM groups WHERE key = 'mitglied'), 'Char', 'Akter', 'Ch', true) RETURNING id`,
    [`mappe-${crypto.randomUUID()}@example.org`]
  );
  if (hubSub) await query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'hub', $2)", [rows[0].id, hubSub]);
  return rows[0].id;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('mapping by label, per field type; nothing for staff-only fields', () => {
  const schema = [
    { key: 'volk', label: 'Volk / Rasse', type: 'select', options: ['Mensch', 'Elf', 'Zwerg'] },
    { key: 'klasse', label: 'Klasse', type: 'text' },
    { key: 'kurz', label: 'Kurzbeschreibung', type: 'textarea', staffOnly: true },
    { key: 'bio', label: 'Hintergrundgeschichte', type: 'document' },
    { key: 'alter', label: 'Alter', type: 'number' },
  ];
  const out = mapHubCharacter({ name: ' Borin ', people: 'zwerg', profession: 'Schmied\nund Krieger', summary: 'Brummig.', background: 'Erste <Zeile>\n\nZweiter Absatz.' }, schema);
  assert.equal(out.name, 'Borin');
  assert.deepEqual(out.data, { volk: 'Zwerg', klasse: 'Schmied und Krieger', bio: '<p>Erste &lt;Zeile&gt;</p><p>Zweiter Absatz.</p>' });
  assert.deepEqual(out.unmatched, ['summary']);
  assert.deepEqual(mapHubCharacter({ name: 'X', people: 'Ork' }, schema).unmatched, ['people'], 'select without that option');
});

test('fetches with the client credentials and the linked sub; states for every case', async () => {
  for (const k of ENV) delete process.env[k];
  const linked = await user({ hubSub: crypto.randomUUID() });
  const plain = await user();
  assert.equal((await fetchHubCharacters(linked, () => { throw new Error('no fetch'); })).state, 'unavailable');

  process.env.HUB_ISSUER = 'https://hub.example';
  process.env.HUB_CLIENT_ID = 'qi_0123456789abcdef';
  process.env.HUB_CLIENT_SECRET = 'geheim';
  assert.equal((await fetchHubCharacters(plain, () => { throw new Error('no fetch'); })).state, 'not-linked');

  const sub = (await query("SELECT provider_user_id FROM oauth_accounts WHERE user_id = $1", [linked])).rows[0].provider_user_id;
  let seen;
  const ok = await fetchHubCharacters(linked, async (url, init) => {
    seen = { url: String(url), auth: init.headers.Authorization };
    return json(200, { sub, characters: [
      { id: 'c1', name: 'Aralin', people: 'Elfe', image: { type: 'image/png', base64: 'iVBORw0KGgo=' } },
      { id: 'c2', name: 'Kaputt', image: { type: 'image/svg+xml', base64: 'PHN2Zz4=' } },
      { id: 'c3', name: '   ' },
    ] });
  });
  assert.equal(seen.url, `https://hub.example/api/v1/characters?sub=${sub}`);
  assert.equal(seen.auth, `Basic ${Buffer.from('qi_0123456789abcdef:geheim').toString('base64')}`);
  assert.equal(ok.state, 'ok');
  assert.deepEqual(ok.characters.map((c) => [c.name, c.image?.type ?? null]), [['Aralin', 'image/png'], ['Kaputt', null]]);

  assert.equal((await fetchHubCharacters(linked, async () => json(403, { error: 'no consent' }))).state, 'no-consent');
  assert.equal((await fetchHubCharacters(linked, async () => json(502, {}))).state, 'error');
});
