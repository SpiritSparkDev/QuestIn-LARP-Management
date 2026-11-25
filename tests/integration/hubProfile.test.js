// Phase 4 auf der Instanzseite: Zuordnung, Profilabruf beim Hub-Login,
// Abgleich/Übernahme, Webhooks (Widerruf, Löschung), Löschfristen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.OAUTH_REDIRECT_BASE_URL = 'http://localhost:3000';
process.env.HUB_CLIENT_ID = 'instanz-p';
process.env.HUB_CLIENT_SECRET = 'profil-geheim';
delete process.env.SMTP_HOST;
delete process.env.APP_MODE;

// --- Fake-Hub mit Profil-API -------------------------------------------------
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const codes = new Map();
const tokens = new Map(); // access token -> { claims, profileAnswer }
const fakeHub = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const auth = String(req.headers.authorization ?? '').replace('Bearer ', '');
  if (url.pathname === '/oidc/.well-known/openid-configuration') {
    return send(200, { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/me`, jwks_uri: `${issuer}/jwks` });
  }
  if (url.pathname === '/oidc/jwks') return send(200, { keys: [jwk] });
  if (url.pathname === '/oidc/token') {
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const entry = codes.get(form.get('code'));
    if (!entry) return send(400, { error: 'invalid_grant' });
    const idToken = await new SignJWT({ nonce: entry.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer).setAudience('instanz-p').setSubject(entry.claims.sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const accessToken = crypto.randomUUID();
    tokens.set(accessToken, entry);
    return send(200, { access_token: accessToken, id_token: idToken });
  }
  if (url.pathname === '/oidc/me') return tokens.has(auth) ? send(200, tokens.get(auth).claims) : send(401, {});
  if (url.pathname === '/api/v1/profile') return tokens.has(auth) ? send(200, tokens.get(auth).profileAnswer) : send(401, {});
  send(404, {});
}).listen(0);
const issuer = `http://localhost:${fakeHub.address().port}/oidc`;
process.env.HUB_ISSUER = issuer;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');
const { getAccountFieldSchema, setAccountFieldSchema } = await import('../../backend/accountFieldSchema/repository.js');
const { purgeExpiredHubSnapshots } = await import('../../backend/hubProfile/repository.js');
const { getAccount } = await import('../../backend/accounts/repository.js');

test.beforeEach(resetRateLimits);

const SCHEMA_EXTRA = [
  { key: 'hp_phone', label: 'Telefon (Test)', type: 'text', required: false },
  { key: 'hp_allergies', label: 'Allergien (Test)', type: 'text', required: false },
];
const originalSchema = await getAccountFieldSchema();
await setAccountFieldSchema([...originalSchema.filter((f) => !f.key.startsWith('hp_')), ...SCHEMA_EXTRA]);
await query('DELETE FROM hub_profile_mapping');
await query("INSERT INTO hub_profile_mapping VALUES ('phone', 'hp_phone'), ('allergies', 'hp_allergies')");

const jarOf = (res, jar = {}) => {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(eq + 1)) jar[pair.slice(0, eq)] = pair.slice(eq + 1); else delete jar[pair.slice(0, eq)];
  }
  return jar;
};
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

const FULL_PROFILE = { phone: '0170 555', address_city: 'Feste', allergies: 'Nüsse', birth_date: '1990-01-01' };

// Hub-Login (optional mit ?profile=1). Gibt Cookies (inkl. Sitzung) und die Startadresse zurück.
async function hubLogin(port, { sub, email, profile = false, profileAnswer }) {
  const start = await fetch(`http://localhost:${port}/auth/oauth/hub/start${profile ? '?profile=1' : ''}`, { redirect: 'manual' });
  const auth = new URL(start.headers.get('location'));
  const jar = jarOf(start);
  const code = crypto.randomUUID();
  codes.set(code, {
    claims: { sub, email, email_verified: true, given_name: 'Pia', family_name: 'Profil' },
    nonce: auth.searchParams.get('nonce'),
    profileAnswer,
  });
  const cb = await fetch(`http://localhost:${port}/auth/oauth/hub/callback?code=${code}&state=${auth.searchParams.get('state')}`,
    { headers: { Cookie: cookieHeader(jar) }, redirect: 'manual' });
  assert.equal(cb.status, 302);
  return { jar: jarOf(cb, jar), auth };
}

async function linkedUser(port) {
  const sub = `sub-${crypto.randomUUID()}`;
  const email = `hp-${crypto.randomUUID()}@example.com`;
  const { jar } = await hubLogin(port, { sub, email });
  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email]);
  return { sub, email, id: rows[0].id, cookie: `session=${jar.session}` };
}

const getOffer = async (port, cookie) => (await fetch(`http://localhost:${port}/hub/profile`, { headers: { Cookie: cookie } })).json();

function signed(body, { secret = 'profil-geheim', ts = Math.floor(Date.now() / 1000) } = {}) {
  const text = JSON.stringify(body);
  return {
    method: 'POST', body: text,
    headers: { 'Content-Type': 'application/json', 'X-QuestIn-Timestamp': String(ts), 'X-QuestIn-Signature': crypto.createHmac('sha256', secret).update(`${ts}.${text}`).digest('hex') },
  };
}

// --- Tests -------------------------------------------------------------------

test('profile=1 fragt Scope questin_profile mit prompt=consent an', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/oauth/hub/start?profile=1`, { redirect: 'manual' });
    const auth = new URL(res.headers.get('location'));
    assert.equal(auth.searchParams.get('scope'), 'openid email profile questin_profile');
    assert.equal(auth.searchParams.get('prompt'), 'consent');
    const plain = new URL((await fetch(`http://localhost:${port}/auth/oauth/hub/start`, { redirect: 'manual' })).headers.get('location'));
    assert.equal(plain.searchParams.get('scope'), 'openid email profile');
  });
});

test('ohne Einwilligung: keine Daten, nichts angeboten', async () => {
  await withTestServer(async (port) => {
    const u = await linkedUser(port);
    await hubLogin(port, { sub: u.sub, email: u.email, profile: true, profileAnswer: { sub: u.sub, categories: [], profile: {} } });
    const { rows } = await query('SELECT 1 FROM hub_profile_snapshots WHERE user_id = $1', [u.id]);
    assert.equal(rows.length, 0);
    const offer = await getOffer(port, u.cookie);
    assert.deepEqual(offer.items, []);
  });
});

test('Gesundheit getrennt verweigert: nur eingewilligte Kategorien landen in der Kopie, auch wenn mehr geliefert wird', async () => {
  await withTestServer(async (port) => {
    const u = await linkedUser(port);
    await hubLogin(port, { sub: u.sub, email: u.email, profile: true, profileAnswer: { sub: u.sub, categories: ['kontakt'], profile: FULL_PROFILE } });
    const { rows } = await query('SELECT category FROM hub_profile_snapshots WHERE user_id = $1', [u.id]);
    assert.deepEqual(rows.map((r) => r.category), ['kontakt']);
    const offer = await getOffer(port, u.cookie);
    assert.deepEqual(offer.items.map((i) => i.hubKey), ['phone'], 'nur zugeordnete Felder (address_city nicht zugeordnet), keine Allergien');
    assert.equal(offer.items[0].hub, '0170 555');
    assert.equal(offer.items[0].same, false);
  });
});

test('Abweichung wird angeboten, nicht überschrieben; Übernahme durch die Person + Audit', async () => {
  await withTestServer(async (port) => {
    const u = await linkedUser(port);
    await fetch(`http://localhost:${port}/account`, { method: 'PATCH', headers: { Cookie: u.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ hp_phone: '0000' }) });
    await hubLogin(port, { sub: u.sub, email: u.email, profile: true, profileAnswer: { sub: u.sub, categories: ['kontakt', 'gesundheit'], profile: FULL_PROFILE } });
    assert.equal((await getAccount(u.id)).hp_phone, '0000', 'nicht automatisch überschrieben');

    const offer = await getOffer(port, u.cookie);
    assert.deepEqual(offer.items.map((i) => [i.hubKey, i.local, i.hub]).sort(), [['allergies', '', 'Nüsse'], ['phone', '0000', '0170 555']]);
    const apply = await fetch(`http://localhost:${port}/hub/profile/apply`, {
      method: 'POST', headers: { Cookie: u.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['phone'] }),
    });
    assert.deepEqual(await apply.json(), { applied: ['hp_phone'] });
    const account = await getAccount(u.id);
    assert.equal(account.hp_phone, '0170 555');
    assert.equal(account.hp_allergies, undefined, 'nicht ausgewählt, nicht übernommen');
    const audit = await query("SELECT details FROM audit_log WHERE action = 'hub.fields_applied' AND subject_user_id = $1", [u.id]);
    assert.deepEqual(audit.rows[0].details.fields, ['hp_phone']);
  });
});

test('abweichendes Schema: zugeordnetes Feld, das es lokal nicht mehr gibt, wird ignoriert', async () => {
  await withTestServer(async (port) => {
    const u = await linkedUser(port);
    await hubLogin(port, { sub: u.sub, email: u.email, profile: true, profileAnswer: { sub: u.sub, categories: ['kontakt'], profile: FULL_PROFILE } });
    await query("UPDATE hub_profile_mapping SET account_field_key = 'gibt_es_nicht' WHERE hub_key = 'phone'");
    try {
      assert.deepEqual((await getOffer(port, u.cookie)).items, []);
    } finally {
      await query("UPDATE hub_profile_mapping SET account_field_key = 'hp_phone' WHERE hub_key = 'phone'");
    }
  });
});

test('Admin-Zuordnung prüft Hub-Schlüssel und Kontofelder', async () => {
  await withTestServer(async (port) => {
    const email = `admin-${crypto.randomUUID()}@example.com`;
    const { hashPassword } = await import('../../backend/crypto/password.js');
    await query(`INSERT INTO users (email, password_hash, group_id, first_name, last_name, email_verified)
      VALUES ($1, $2, (SELECT id FROM groups WHERE key = 'admin'), 'Ad', 'Min', true)`, [email, await hashPassword('admin-passwort')]);
    const login = await fetch(`http://localhost:${port}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'admin-passwort' }) });
    const cookie = cookieHeader(jarOf(login));
    const put = (mapping) => fetch(`http://localhost:${port}/admin/hub-profile-mapping`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ mapping }) });
    assert.equal((await put({ unbekannt: 'hp_phone' })).status, 400);
    assert.equal((await put({ phone: 'kein_feld' })).status, 400);
    const ok = await put({ phone: 'hp_phone', allergies: 'hp_allergies', birth_date: '' });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).mapping, { phone: 'hp_phone', allergies: 'hp_allergies' });

    const u = await linkedUser(port);
    assert.equal((await put({ phone: 'hp_phone' }).then(() => fetch(`http://localhost:${port}/admin/hub-profile-mapping`, { headers: { Cookie: u.cookie } }))).status, 403);
    await put({ phone: 'hp_phone', allergies: 'hp_allergies' });
  });
});

test('Webhook consent.revoked löscht die Kategorie; falsche oder alte Signatur wird abgelehnt', async () => {
  await withTestServer(async (port) => {
    const u = await linkedUser(port);
    await hubLogin(port, { sub: u.sub, email: u.email, profile: true, profileAnswer: { sub: u.sub, categories: ['kontakt', 'gesundheit'], profile: FULL_PROFILE } });
    const event = { event: 'consent.revoked', sub: u.sub, categories: ['gesundheit'] };
    const url = `http://localhost:${port}/api/hub/webhook`;
    assert.equal((await fetch(url, signed(event, { secret: 'falsch' }))).status, 401);
    assert.equal((await fetch(url, signed(event, { ts: Math.floor(Date.now() / 1000) - 3600 }))).status, 401);
    assert.equal((await fetch(url, signed(event))).status, 200);
    const { rows } = await query('SELECT category FROM hub_profile_snapshots WHERE user_id = $1', [u.id]);
    assert.deepEqual(rows.map((r) => r.category), ['kontakt']);
  });
});

test('Webhook account.deleted: Kopie weg, Verknüpfung gelöst, lokales Konto bleibt', async () => {
  await withTestServer(async (port) => {
    const u = await linkedUser(port);
    await hubLogin(port, { sub: u.sub, email: u.email, profile: true, profileAnswer: { sub: u.sub, categories: ['kontakt'], profile: FULL_PROFILE } });
    const res = await fetch(`http://localhost:${port}/api/hub/webhook`, signed({ event: 'account.deleted', sub: u.sub }));
    assert.equal(res.status, 200);
    assert.equal((await query('SELECT 1 FROM hub_profile_snapshots WHERE user_id = $1', [u.id])).rows.length, 0);
    assert.equal((await query("SELECT 1 FROM oauth_accounts WHERE user_id = $1 AND provider = 'hub'", [u.id])).rows.length, 0);
    assert.equal((await query('SELECT 1 FROM users WHERE id = $1', [u.id])).rows.length, 1);
  });
});

test('Löschfrist: Gesundheit nach 28 Tagen weg, Kontakt bleibt bis 180 Tage', async () => {
  await withTestServer(async (port) => {
    const u = await linkedUser(port);
    await hubLogin(port, { sub: u.sub, email: u.email, profile: true, profileAnswer: { sub: u.sub, categories: ['kontakt', 'gesundheit'], profile: FULL_PROFILE } });
    await query("UPDATE hub_profile_snapshots SET fetched_at = now() - interval '30 days' WHERE user_id = $1", [u.id]);
    await purgeExpiredHubSnapshots();
    let { rows } = await query('SELECT category FROM hub_profile_snapshots WHERE user_id = $1', [u.id]);
    assert.deepEqual(rows.map((r) => r.category), ['kontakt']);
    await query("UPDATE hub_profile_snapshots SET fetched_at = now() - interval '181 days' WHERE user_id = $1", [u.id]);
    await purgeExpiredHubSnapshots();
    ({ rows } = await query('SELECT category FROM hub_profile_snapshots WHERE user_id = $1', [u.id]));
    assert.equal(rows.length, 0);
  });
});

test.after(async () => {
  await setAccountFieldSchema(originalSchema);
  await query('DELETE FROM hub_profile_mapping');
  fakeHub.close();
  await closePool();
});

test('Meine Anmeldungen: Hub fragt signiert, bekommt nur Event, Status, Rolle und Zahlungsstand', async () => {
  await withTestServer(async (port) => {
    const u = await linkedUser(port);
    const { rows: [event] } = await query("INSERT INTO events (name, event_date, end_date) VALUES ('Hub-Testcon', '2099-07-01', '2099-07-03') RETURNING id");
    const { rows: [character] } = await query("INSERT INTO characters (user_id, name) VALUES ($1, 'Aldric') RETURNING id", [u.id]);
    await query(`INSERT INTO registrations (user_id, event_id, con_role, character_id, status, amount_due_cents)
      VALUES ($1, $2, 'sc', $3, 'confirmed', 4500)`, [u.id, event.id, character.id]);
    const url = `http://localhost:${port}/api/hub/registrations`;

    assert.equal((await fetch(url, signed({ sub: u.sub }, { secret: 'falsch' }))).status, 401);
    assert.equal((await fetch(url, signed({ sub: u.sub }, { ts: Math.floor(Date.now() / 1000) - 3600 }))).status, 401);
    assert.equal((await fetch(url, signed({}))).status, 400);

    const res = await fetch(url, signed({ sub: u.sub }));
    assert.equal(res.status, 200);
    const { registrations } = await res.json();
    assert.equal(registrations.length, 1);
    const [r] = registrations;
    assert.equal(r.eventName, 'Hub-Testcon');
    assert.equal(r.startDate, '2099-07-01');
    assert.equal(r.endDate, '2099-07-03');
    assert.equal(r.status, 'confirmed');
    assert.equal(r.statusLabel, 'Bestätigt');
    assert.equal(r.role, 'SC');
    assert.equal(r.characterName, 'Aldric');
    assert.deepEqual(r.payment, { state: 'open', amountDueCents: 4500 });
    assert.match(r.url, /\/account\.html#anmelden$/);
    assert.deepEqual(Object.keys(r).sort(), ['characterName', 'endDate', 'eventName', 'payment', 'role', 'startDate', 'status', 'statusLabel', 'url']);

    await query('UPDATE registrations SET paid_at = now() WHERE user_id = $1', [u.id]);
    const paid = await (await fetch(url, signed({ sub: u.sub }))).json();
    assert.deepEqual(paid.registrations[0].payment, { state: 'paid' });

    const unknown = await (await fetch(url, signed({ sub: 'unbekannt' }))).json();
    assert.deepEqual(unknown.registrations, []);
  });
});
