// "Mit QuestIn anmelden" gegen einen Fake-Hub (lokaler http-Server mit
// Discovery, JWKS, Token, Userinfo und Import-API; Tokens mit jose signiert).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.OAUTH_REDIRECT_BASE_URL = 'http://localhost:3000';
process.env.HUB_CLIENT_ID = 'instanz-a';
process.env.HUB_CLIENT_SECRET = 'geheim:mit/sonderzeichen';
delete process.env.SMTP_HOST;
delete process.env.APP_MODE;

// --- Fake-Hub ---------------------------------------------------------------
const { privateKey, publicKey } = await generateKeyPair('RS256');
const { privateKey: foreignKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const codes = new Map(); // code -> { claims, challenge, nonce, key, aud }
const accessTokens = new Map(); // access token -> userinfo
const hub = { importCalls: [], importResponse: { status: 201, body: { sub: 'unused' } } };

const fakeHub = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const basicOk = req.headers.authorization === `Basic ${Buffer.from(`${encodeURIComponent(process.env.HUB_CLIENT_ID)}:${encodeURIComponent(process.env.HUB_CLIENT_SECRET)}`).toString('base64')}`;

  if (url.pathname === '/oidc/.well-known/openid-configuration') {
    return send(200, {
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/me`,
      jwks_uri: `${issuer}/jwks`,
    });
  }
  if (url.pathname === '/oidc/jwks') return send(200, { keys: [jwk] });
  if (url.pathname === '/oidc/token' && req.method === 'POST') {
    if (!basicOk) return send(401, { error: 'invalid_client' });
    const form = new URLSearchParams(raw);
    const entry = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    if (!entry) return send(400, { error: 'invalid_grant' });
    const challenge = crypto.createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    if (challenge !== entry.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE' });
    if (form.get('redirect_uri') !== 'http://localhost:3000/auth/oauth/hub/callback') return send(400, { error: 'invalid_grant' });
    const idToken = await new SignJWT({ nonce: entry.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(entry.aud ?? process.env.HUB_CLIENT_ID)
      .setSubject(entry.claims.sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(entry.key ?? privateKey);
    const accessToken = crypto.randomUUID();
    accessTokens.set(accessToken, entry.claims);
    return send(200, { access_token: accessToken, id_token: idToken, token_type: 'Bearer' });
  }
  if (url.pathname === '/oidc/me') {
    const claims = accessTokens.get((req.headers.authorization ?? '').replace('Bearer ', ''));
    return claims ? send(200, claims) : send(401, { error: 'invalid_token' });
  }
  if (url.pathname === '/api/v1/accounts/import' && req.method === 'POST') {
    if (!basicOk) return send(401, { error: 'invalid client credentials' });
    hub.importCalls.push(JSON.parse(raw));
    return send(hub.importResponse.status, hub.importResponse.body);
  }
  send(404, { error: 'not found' });
}).listen(0);
const issuer = `http://localhost:${fakeHub.address().port}/oidc`;
process.env.HUB_ISSUER = issuer;

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { hashPassword } = await import('../../backend/crypto/password.js');
const { resetRateLimits } = await import('../../backend/middleware/rateLimit.js');
const { safeReturnTo } = await import('../../backend/auth/hubLogin.js');

test.beforeEach(() => {
  resetRateLimits();
  delete process.env.APP_MODE;
});

// --- Hilfen -----------------------------------------------------------------
function cookieJar(res, jar = {}) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value) jar[name] = value; else delete jar[name];
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

const newEmail = () => `hub-${crypto.randomUUID()}@example.com`;
const newSub = () => `sub-${crypto.randomUUID()}`;

// Startet den Login, lässt den Fake-Hub einen Code ausstellen und ruft den Callback auf.
async function hubLogin(port, claims, { returnTo, nonce, key, aud, state } = {}) {
  const startUrl = `http://localhost:${port}/auth/oauth/hub/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;
  const start = await fetch(startUrl, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  const jar = cookieJar(start);
  const code = crypto.randomUUID();
  codes.set(code, {
    claims: { email_verified: true, given_name: 'Hub', family_name: 'Person', ...claims },
    challenge: auth.searchParams.get('code_challenge'),
    nonce: nonce ?? auth.searchParams.get('nonce'),
    key,
    aud,
  });
  const callback = await fetch(
    `http://localhost:${port}/auth/oauth/hub/callback?code=${code}&state=${state ?? auth.searchParams.get('state')}`,
    { headers: { Cookie: cookieHeader(jar) }, redirect: 'manual' }
  );
  cookieJar(callback, jar);
  return { start, auth, callback, jar };
}

async function isLoggedIn(port, jar) {
  if (!jar.session) return false;
  const res = await fetch(`http://localhost:${port}/auth/hub/status`, { headers: { Cookie: `session=${jar.session}` } });
  return res.status === 200;
}

async function createLocalUser({ email = newEmail(), password = 'lokales-passwort', deactivated = false } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, group_id, first_name, last_name, nickname, email_verified, deactivated_at)
     VALUES ($1, $2, (SELECT id FROM groups WHERE key = 'mitglied'), 'Lokal', 'Person', 'Lo', true, $3) RETURNING id`,
    [email, password ? await hashPassword(password) : null, deactivated ? new Date() : null]
  );
  return { id: rows[0].id, email, password };
}

const hubLinkOf = async (userId) => (await query(
  "SELECT provider_user_id FROM oauth_accounts WHERE user_id = $1 AND provider = 'hub'", [userId]
)).rows[0]?.provider_user_id;

// --- Tests ------------------------------------------------------------------
test('providers meldet hub als verfügbar, ohne Geheimnisse', async () => {
  await withTestServer(async (port) => {
    const body = await (await fetch(`http://localhost:${port}/auth/oauth/providers`)).json();
    assert.equal(body.hub, true);
    assert.ok(!JSON.stringify(body).includes(process.env.HUB_CLIENT_SECRET));
  });
});

test('start leitet mit PKCE (S256), nonce und state zum Hub', async () => {
  await withTestServer(async (port) => {
    const start = await fetch(`http://localhost:${port}/auth/oauth/hub/start`, { redirect: 'manual' });
    const auth = new URL(start.headers.get('location'));
    assert.equal(auth.origin + auth.pathname, `${issuer}/auth`);
    assert.equal(auth.searchParams.get('client_id'), 'instanz-a');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(auth.searchParams.get('code_challenge'));
    assert.ok(auth.searchParams.get('nonce'));
    assert.equal(auth.searchParams.get('scope'), 'openid email profile');
    const cookies = start.headers.getSetCookie().join('\n');
    for (const name of ['oauth_state_hub=', 'oauth_nonce_hub=', 'oauth_pkce_hub=']) assert.ok(cookies.includes(name), name);
    assert.ok(cookies.includes('HttpOnly'));
  });
});

test('neuer Nutzer: lokales Konto ohne Passwort, Namen vom Hub, verknüpft, eingeloggt', async () => {
  await withTestServer(async (port) => {
    const email = newEmail();
    const sub = newSub();
    const { callback, jar } = await hubLogin(port, { sub, email, given_name: 'Ada', family_name: 'Lovelace' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/account.html');
    assert.ok(await isLoggedIn(port, jar));
    const { rows } = await query('SELECT id, password_hash, first_name, last_name, email_verified FROM users WHERE email = $1', [email]);
    assert.equal(rows[0].password_hash, null);
    assert.equal(rows[0].first_name, 'Ada');
    assert.equal(rows[0].last_name, 'Lovelace');
    assert.equal(rows[0].email_verified, true);
    assert.equal(await hubLinkOf(rows[0].id), sub);
  });
});

test('bekannte sub meldet dasselbe Konto an, auch wenn sich die E-Mail am Hub geändert hat', async () => {
  await withTestServer(async (port) => {
    const sub = newSub();
    const email = newEmail();
    await hubLogin(port, { sub, email });
    const { callback, jar } = await hubLogin(port, { sub, email: newEmail() });
    assert.equal(callback.headers.get('location'), '/account.html');
    assert.ok(await isLoggedIn(port, jar));
    const { rows } = await query("SELECT count(*)::int AS n FROM oauth_accounts WHERE provider = 'hub' AND provider_user_id = $1", [sub]);
    assert.equal(rows[0].n, 1);
  });
});

const userIdOfSub = async (sub) => (await query(
  "SELECT user_id FROM oauth_accounts WHERE provider = 'hub' AND provider_user_id = $1", [sub]
)).rows[0].user_id;

test('E-Mail-Regel: geänderte, bestätigte Hub-E-Mail wird lokal übernommen, wenn frei', async () => {
  await withTestServer(async (port) => {
    const sub = newSub();
    const oldEmail = newEmail();
    const changed = newEmail();
    await hubLogin(port, { sub, email: oldEmail });
    const { jar } = await hubLogin(port, { sub, email: changed.toUpperCase() });
    assert.ok(await isLoggedIn(port, jar));
    const userId = await userIdOfSub(sub);
    assert.equal((await query('SELECT email FROM users WHERE id = $1', [userId])).rows[0].email, changed);
    const audit = await query("SELECT details FROM audit_log WHERE action = 'hub.email_updated' AND subject_user_id = $1", [userId]);
    assert.deepEqual(audit.rows[0].details, { from: oldEmail, to: changed });
  });
});

test('E-Mail-Regel: Hub-E-Mail schon von anderem lokalen Konto belegt → nichts ändern, protokollieren', async () => {
  await withTestServer(async (port) => {
    const sub = newSub();
    const ownEmail = newEmail();
    const other = await createLocalUser();
    await hubLogin(port, { sub, email: ownEmail });
    const { jar } = await hubLogin(port, { sub, email: other.email });
    assert.ok(await isLoggedIn(port, jar), 'Login klappt trotzdem');
    const userId = await userIdOfSub(sub);
    assert.equal((await query('SELECT email FROM users WHERE id = $1', [userId])).rows[0].email, ownEmail);
    assert.equal((await query('SELECT email FROM users WHERE id = $1', [other.id])).rows[0].email, other.email);
    const audit = await query("SELECT details FROM audit_log WHERE action = 'hub.email_conflict' AND subject_user_id = $1", [userId]);
    assert.deepEqual(audit.rows[0].details, { local: ownEmail, hub: other.email });
  });
});

test('E-Mail-Regel: unbestätigte Hub-E-Mail wird nicht übernommen', async () => {
  await withTestServer(async (port) => {
    const sub = newSub();
    const ownEmail = newEmail();
    await hubLogin(port, { sub, email: ownEmail });
    await hubLogin(port, { sub, email: newEmail(), email_verified: false });
    assert.equal((await query('SELECT email FROM users WHERE id = $1', [await userIdOfSub(sub)])).rows[0].email, ownEmail);
  });
});

test('gleiche E-Mail wie lokales Konto: keine automatische Verknüpfung, Bestätigungsseite', async () => {
  await withTestServer(async (port) => {
    const local = await createLocalUser();
    const { callback, jar } = await hubLogin(port, { sub: newSub(), email: local.email });
    assert.equal(callback.headers.get('location'), '/hub-link.html');
    assert.ok(!jar.session, 'keine Sitzung ohne Bestätigung');
    assert.ok(jar.hub_link);
    assert.equal(await hubLinkOf(local.id), undefined);

    const info = await (await fetch(`http://localhost:${port}/auth/hub/link`, { headers: { Cookie: cookieHeader(jar) } })).json();
    assert.deepEqual(info, { email: local.email, hasPassword: true });
  });
});

test('Bestätigung mit richtigem Passwort verknüpft, meldet an und protokolliert', async () => {
  await withTestServer(async (port) => {
    const local = await createLocalUser();
    const sub = newSub();
    const { jar } = await hubLogin(port, { sub, email: local.email }, { returnTo: '/events.html?x=1' });
    const res = await fetch(`http://localhost:${port}/auth/hub/link`, {
      method: 'POST', headers: { Cookie: cookieHeader(jar), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: local.password }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { redirect: '/events.html?x=1' });
    cookieJar(res, jar);
    assert.ok(await isLoggedIn(port, jar));
    assert.equal(await hubLinkOf(local.id), sub);
    const audit = await query("SELECT details FROM audit_log WHERE action = 'hub.linked' AND subject_user_id = $1", [local.id]);
    assert.equal(audit.rows[0].details.via, 'password');

    // Einmalig: dieselbe Anfrage kann nicht noch einmal benutzt werden.
    const again = await fetch(`http://localhost:${port}/auth/hub/link`, {
      method: 'POST', headers: { Cookie: `hub_link=${jar.hub_link ?? 'weg'}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: local.password }),
    });
    assert.equal(again.status, 410);
  });
});

test('falsches Passwort verknüpft nicht', async () => {
  await withTestServer(async (port) => {
    const local = await createLocalUser();
    const { jar } = await hubLogin(port, { sub: newSub(), email: local.email });
    const res = await fetch(`http://localhost:${port}/auth/hub/link`, {
      method: 'POST', headers: { Cookie: cookieHeader(jar), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'falsch' }),
    });
    assert.equal(res.status, 401);
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('session=')));
    assert.equal(await hubLinkOf(local.id), undefined);
  });
});

test('abgelaufene Link-Anfrage wird abgelehnt', async () => {
  await withTestServer(async (port) => {
    const local = await createLocalUser();
    const { jar } = await hubLogin(port, { sub: newSub(), email: local.email });
    await query("UPDATE hub_link_requests SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [local.id]);
    const res = await fetch(`http://localhost:${port}/auth/hub/link`, {
      method: 'POST', headers: { Cookie: cookieHeader(jar), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: local.password }),
    });
    assert.equal(res.status, 410);
    assert.equal(await hubLinkOf(local.id), undefined);
  });
});

test('lokales Konto ohne Passwort: Bestätigung per Mail-Link verknüpft', async () => {
  await withTestServer(async (port) => {
    const local = await createLocalUser({ password: null });
    const sub = newSub();
    const { jar } = await hubLogin(port, { sub, email: local.email });
    const mail = await fetch(`http://localhost:${port}/auth/hub/link/email`, {
      method: 'POST', headers: { Cookie: cookieHeader(jar), 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(mail.status, 200);
    const { rows } = await query('SELECT email_token_hash FROM hub_link_requests WHERE user_id = $1', [local.id]);
    assert.ok(rows[0].email_token_hash);

    // Der echte Token steht nur in der Mail; im Test setzen wir einen bekannten.
    const token = 'mail-token-' + crypto.randomUUID();
    await query('UPDATE hub_link_requests SET email_token_hash = $2 WHERE user_id = $1',
      [local.id, crypto.createHash('sha256').update(token).digest('hex')]);
    const confirm = await fetch(`http://localhost:${port}/auth/hub/link/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    assert.equal(confirm.status, 200);
    assert.equal(await hubLinkOf(local.id), sub);

    const reuse = await fetch(`http://localhost:${port}/auth/hub/link/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    assert.equal(reuse.status, 410);
  });
});

test('Passwort-Bestätigung ist für Konten ohne Passwort gesperrt, Mail-Link für Konten mit Passwort', async () => {
  await withTestServer(async (port) => {
    const withPassword = await createLocalUser();
    const a = await hubLogin(port, { sub: newSub(), email: withPassword.email });
    const mail = await fetch(`http://localhost:${port}/auth/hub/link/email`, { method: 'POST', headers: { Cookie: cookieHeader(a.jar) }, body: '{}' });
    assert.equal(mail.status, 400);

    const without = await createLocalUser({ password: null });
    const b = await hubLogin(port, { sub: newSub(), email: without.email });
    const pw = await fetch(`http://localhost:${port}/auth/hub/link`, {
      method: 'POST', headers: { Cookie: cookieHeader(b.jar) }, body: JSON.stringify({ password: '' }),
    });
    assert.equal(pw.status, 400);
  });
});

test('unbestätigte Hub-E-Mail: kein neues Konto, keine Verknüpfung', async () => {
  await withTestServer(async (port) => {
    const email = newEmail();
    const { callback, jar } = await hubLogin(port, { sub: newSub(), email, email_verified: false });
    assert.equal(callback.headers.get('location'), '/login.html?oauth_error=hub_email_unverified');
    assert.ok(!jar.session);
    const { rows } = await query('SELECT 1 FROM users WHERE email = $1', [email]);
    assert.equal(rows.length, 0);
  });
});

test('falscher state wird abgelehnt', async () => {
  await withTestServer(async (port) => {
    const { callback, jar } = await hubLogin(port, { sub: newSub(), email: newEmail() }, { state: 'falsch' });
    assert.equal(callback.status, 400);
    assert.ok(!jar.session);
  });
});

test('falsche nonce im id_token wird abgelehnt', async () => {
  await withTestServer(async (port) => {
    const email = newEmail();
    const { callback, jar } = await hubLogin(port, { sub: newSub(), email }, { nonce: 'fremde-nonce' });
    assert.equal(callback.headers.get('location'), '/login.html?oauth_error=hub_failed');
    assert.ok(!jar.session);
    assert.equal((await query('SELECT 1 FROM users WHERE email = $1', [email])).rows.length, 0);
  });
});

test('id_token mit fremder Signatur wird abgelehnt', async () => {
  await withTestServer(async (port) => {
    const { callback, jar } = await hubLogin(port, { sub: newSub(), email: newEmail() }, { key: foreignKey });
    assert.equal(callback.headers.get('location'), '/login.html?oauth_error=hub_failed');
    assert.ok(!jar.session);
  });
});

test('id_token für einen anderen Client (aud) wird abgelehnt', async () => {
  await withTestServer(async (port) => {
    const { callback, jar } = await hubLogin(port, { sub: newSub(), email: newEmail() }, { aud: 'instanz-b' });
    assert.equal(callback.headers.get('location'), '/login.html?oauth_error=hub_failed');
    assert.ok(!jar.session);
  });
});

test('zweite sub auf ein schon verknüpftes lokales Konto wird abgelehnt', async () => {
  await withTestServer(async (port) => {
    const email = newEmail();
    const first = newSub();
    await hubLogin(port, { sub: first, email });
    const { callback, jar } = await hubLogin(port, { sub: newSub(), email });
    assert.equal(callback.headers.get('location'), '/login.html?oauth_error=hub_other_account');
    assert.ok(!jar.session);
    const { rows } = await query('SELECT id FROM users WHERE email = $1', [email]);
    assert.equal(await hubLinkOf(rows[0].id), first);
  });
});

test('deaktiviertes Konto wird abgelehnt (über E-Mail und über bekannte sub)', async () => {
  await withTestServer(async (port) => {
    const local = await createLocalUser({ deactivated: true });
    const viaEmail = await hubLogin(port, { sub: newSub(), email: local.email });
    assert.equal(viaEmail.callback.headers.get('location'), '/login.html?oauth_error=deactivated');

    const sub = newSub();
    const email = newEmail();
    await hubLogin(port, { sub, email });
    await query('UPDATE users SET deactivated_at = now() WHERE email = $1', [email]);
    const viaSub = await hubLogin(port, { sub, email });
    assert.equal(viaSub.callback.headers.get('location'), '/login.html?oauth_error=deactivated');
    assert.ok(!viaSub.jar.session);
  });
});

test('Offline-Modus blockiert den Hub-Login', async () => {
  await withTestServer(async (port) => {
    process.env.APP_MODE = 'offline';
    const start = await fetch(`http://localhost:${port}/auth/oauth/hub/start`, { redirect: 'manual' });
    assert.equal(start.headers.get('location'), '/login.html?oauth_error=offline');

    // Auch ein Callback, der noch vor dem Umschalten begonnen wurde.
    delete process.env.APP_MODE;
    const begun = await fetch(`http://localhost:${port}/auth/oauth/hub/start`, { redirect: 'manual' });
    const jar = cookieJar(begun);
    const state = new URL(begun.headers.get('location')).searchParams.get('state');
    process.env.APP_MODE = 'offline';
    const callback = await fetch(`http://localhost:${port}/auth/oauth/hub/callback?code=x&state=${state}`, {
      headers: { Cookie: cookieHeader(jar) }, redirect: 'manual',
    });
    assert.equal(callback.headers.get('location'), '/login.html?oauth_error=offline');
  });
});

test('returnTo: relativer Pfad wird nach dem Login angesprungen, absolute URLs ignoriert', async () => {
  await withTestServer(async (port) => {
    const ok = await hubLogin(port, { sub: newSub(), email: newEmail() }, { returnTo: '/events.html?event=42' });
    assert.equal(ok.callback.headers.get('location'), '/events.html?event=42');
    for (const evil of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)']) {
      const res = await hubLogin(port, { sub: newSub(), email: newEmail() }, { returnTo: evil });
      assert.equal(res.callback.headers.get('location'), '/account.html', evil);
    }
  });
});

test('safeReturnTo lässt nur einfache relative Pfade durch', () => {
  assert.equal(safeReturnTo('/a/b?c=d#e'), '/a/b?c=d#e');
  for (const bad of [null, '', 'a', 'https://x', '//x', '/\\x', '\\\\x', '/a\nb', 'x'.repeat(600)]) {
    assert.equal(safeReturnTo(bad), null, String(bad));
  }
});

async function loggedInLocalUser(port) {
  const local = await createLocalUser();
  const login = await fetch(`http://localhost:${port}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: local.email, password: local.password }),
  });
  assert.equal(login.status, 200);
  return { ...local, cookie: cookieHeader(cookieJar(login)) };
}

test('Opt-in 201: überträgt Daten inkl. Hash, verknüpft und protokolliert', async () => {
  await withTestServer(async (port) => {
    const user = await loggedInLocalUser(port);
    const sub = newSub();
    hub.importResponse = { status: 201, body: { sub, emailVerified: true } };
    hub.importCalls.length = 0;

    const noConsent = await fetch(`http://localhost:${port}/auth/hub/optin`, {
      method: 'POST', headers: { Cookie: user.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: false }),
    });
    assert.equal(noConsent.status, 400);
    assert.equal(hub.importCalls.length, 0);

    const res = await fetch(`http://localhost:${port}/auth/hub/optin`, {
      method: 'POST', headers: { Cookie: user.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true }),
    });
    assert.equal(res.status, 200);
    const [call] = hub.importCalls;
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    assert.deepEqual(call, {
      email: user.email, passwordHash: rows[0].password_hash, firstName: 'Lokal', lastName: 'Person',
      nickname: 'Lo', emailVerified: true, consent: true,
    });
    assert.equal(await hubLinkOf(user.id), sub);
    assert.ok(rows[0].password_hash, 'lokales Passwort bleibt vorerst erhalten');
    const audit = await query("SELECT 1 FROM audit_log WHERE action = 'hub.optin' AND subject_user_id = $1", [user.id]);
    assert.equal(audit.rows.length, 1);

    const status = await (await fetch(`http://localhost:${port}/auth/hub/status`, { headers: { Cookie: user.cookie } })).json();
    assert.deepEqual(status, { available: true, linked: true });
  });
});

test('Opt-in 409: Hub-Konto existiert schon, Hinweis statt Verknüpfung', async () => {
  await withTestServer(async (port) => {
    const user = await loggedInLocalUser(port);
    hub.importResponse = { status: 409, body: { error: 'account exists', code: 'HUB_ACCOUNT_EXISTS' } };
    const res = await fetch(`http://localhost:${port}/auth/hub/optin`, {
      method: 'POST', headers: { Cookie: user.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'HUB_ACCOUNT_EXISTS');
    assert.match(body.error, /Melde dich einmal mit QuestIn an/);
    assert.equal(await hubLinkOf(user.id), undefined);
  });
});

test('Opt-in nur angemeldet', async () => {
  await withTestServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/auth/hub/optin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true }),
    });
    assert.equal(res.status, 401);
  });
});

test.after(async () => {
  fakeHub.close();
  await closePool();
});
