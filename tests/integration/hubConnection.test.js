// Add-on "QuestIn-Hub": this instance connects itself to the hub (signed
// application, domain proof, credentials fetched and stored encrypted).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.APP_MODE;
const ENV = ['HUB_URL', 'HUB_ISSUER', 'HUB_CLIENT_ID', 'HUB_CLIENT_SECRET'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { query } = await import('../../backend/db.js');
const { createServer } = await import('../../backend/server.js');
const { hubConfig, hubUrl } = await import('../../backend/hubDirectory/config.js');
const { getHubConnection } = await import('../../backend/hubConnection/repository.js');
const service = await import('../../backend/hubConnection/service.js');
const { canonical, keyIdOf, readSignatureHeaders } = await import('../../backend/hubConnection/signature.js');

after(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await query("UPDATE hub_connection SET enabled = false, status = 'off', private_key_enc = NULL, client_secret_enc = NULL, client_id = NULL, key_id = NULL");
});

const HUB = 'https://hub.example';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A small stand-in for the hub that checks every signature like the real one.
function fakeHub(instanceBase) {
  const hub = { calls: [], publicKey: null, keyId: null, challenge: 'challenge-1234567890', status: 'verify-domain', secret: null, nonces: new Set() };
  hub.fetch = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, HUB);
    assert.equal(init.redirect, 'error');
    const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const sig = readSignatureHeaders(headers);
    assert.ok(sig, 'signature headers present');
    const body = init.body ?? '';
    const parsed = body ? JSON.parse(body) : {};
    if (u.pathname === '/api/v1/instances/applications') {
      hub.publicKey = crypto.createPublicKey(parsed.publicKey);
      hub.keyId = keyIdOf(hub.publicKey);
      hub.application = parsed;
    }
    assert.equal(sig.keyId, hub.keyId);
    assert.ok(crypto.verify(null, Buffer.from(canonical({ method: init.method, path: u.pathname + u.search, timestamp: sig.timestamp, nonce: sig.nonce, body })), hub.publicKey, Buffer.from(sig.signature, 'base64url')), 'valid signature');
    assert.ok(!hub.nonces.has(sig.nonce), 'fresh nonce');
    hub.nonces.add(sig.nonce);
    hub.calls.push(`${init.method} ${u.pathname}`);
    switch (u.pathname) {
      case '/api/v1/instances/applications':
        return json(201, { applicationId: '11111111-2222-4333-8444-555555555555', challenge: hub.challenge, keyId: hub.keyId });
      case '/api/v1/instances/verify': {
        const proof = await (await fetch(`${instanceBase}/.well-known/questin-hub`)).json();
        if (proof.challenge !== hub.challenge || proof.keyId !== hub.keyId) return json(422, { status: 'verify-domain', error: 'passt nicht' });
        hub.status = 'confirm-email';
        return json(200, { status: 'confirm-email' });
      }
      case '/api/v1/instances/status':
        return json(200, { status: hub.status, note: hub.status === 'rejected' ? 'Nein.' : null });
      case '/api/v1/instances/credentials':
        if (hub.status !== 'active') return json(409, { status: hub.status });
        hub.secret = crypto.randomBytes(32).toString('base64url');
        return json(200, { hubUrl: HUB, issuer: `${HUB}/oidc`, clientId: 'qi_0123456789abcdef', clientSecret: hub.secret });
      case '/api/v1/instances/disconnect':
        hub.status = 'disconnected';
        return json(200, { status: 'disconnected' });
      default:
        return json(404, {});
    }
  };
  return hub;
}

async function admin() {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Hub', 'Admin', (SELECT id FROM groups WHERE key = 'admin'), true) RETURNING id",
    [`hubadmin-${crypto.randomUUID()}@example.org`]);
  return rows[0].id;
}

const input = { hubUrl: HUB, orgName: 'Orga Test', contactName: 'Kon Takt', contactEmail: 'kontakt@orga.example', couponCode: 'FREUNDE' };

test('add-on: off by default, apply only when on; domain proof, review, credentials, rotation, revoke, disconnect', async () => {
  const server = createServer().listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const actor = await admin();
    const hub = fakeHub(base);
    await query("UPDATE hub_connection SET enabled = false, status = 'off', private_key_enc = NULL, client_secret_enc = NULL, client_id = NULL, key_id = NULL, challenge = NULL");

    assert.equal((await fetch(`${base}/.well-known/questin-hub`)).status, 404);
    assert.equal((await fetch(`${base}/admin/hub-connection`)).status, 401);
    await assert.rejects(service.apply(input, actor, hub.fetch), /nicht aktiviert/);
    assert.equal(hub.calls.length, 0, 'nothing reaches the hub while the add-on is off');

    await service.setEnabled(true, actor, hub.fetch);
    let c = await service.apply(input, actor, hub.fetch);
    assert.deepEqual(hub.calls, ['POST /api/v1/instances/applications', 'POST /api/v1/instances/verify']);
    assert.equal(c.status, 'confirm-email');
    assert.equal(hub.application.couponCode, 'FREUNDE');
    assert.equal(hub.application.privateKey, undefined);
    assert.doesNotMatch(JSON.stringify(hub.application), /PRIVATE KEY/);
    const stored = (await query('SELECT private_key_enc FROM hub_connection')).rows[0].private_key_enc;
    assert.doesNotMatch(stored.toString('utf8'), /PRIVATE KEY/, 'private key stored encrypted');
    assert.equal((await fetch(`${base}/.well-known/questin-hub`)).status, 200);
    await assert.rejects(service.apply(input, actor, hub.fetch), /läuft schon/);

    hub.status = 'review';
    c = await service.refresh(actor, hub.fetch);
    assert.equal(c.status, 'review');
    assert.equal(hubConfig(), null, 'no credentials before approval');

    hub.status = 'active';
    c = await service.refresh(actor, hub.fetch);
    assert.equal(c.status, 'active');
    assert.equal(c.hasCredentials, true);
    assert.deepEqual(hubConfig(), { issuer: `${HUB}/oidc`, clientId: 'qi_0123456789abcdef', clientSecret: hub.secret });
    assert.equal(hubUrl(), HUB);
    assert.equal((await fetch(`${base}/.well-known/questin-hub`)).status, 404, 'proof only while pending');
    const secretRow = (await query('SELECT client_secret_enc FROM hub_connection')).rows[0].client_secret_enc;
    assert.ok(!secretRow.toString('utf8').includes(hub.secret), 'secret stored encrypted');

    const first = hub.secret;
    await service.fetchCredentials(actor, hub.fetch);
    assert.notEqual(hub.secret, first);
    assert.equal(hubConfig().clientSecret, hub.secret, 'rotation takes effect at once');

    // The hub blocks us: signed webhook, credentials go.
    const body = JSON.stringify({ event: 'instance.revoked', reason: 'Test' });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', hub.secret).update(`${ts}.${body}`).digest('hex');
    const bad = await fetch(`${base}/api/hub/webhook`, { method: 'POST', headers: { 'X-QuestIn-Timestamp': ts, 'X-QuestIn-Signature': '0'.repeat(64) }, body });
    assert.equal(bad.status, 401);
    const res = await fetch(`${base}/api/hub/webhook`, { method: 'POST', headers: { 'X-QuestIn-Timestamp': ts, 'X-QuestIn-Signature': signature }, body });
    assert.equal(res.status, 200);
    c = await getHubConnection();
    assert.equal(c.status, 'blocked');
    assert.equal(c.hasCredentials, false);
    assert.equal(hubConfig(), null);

    // Unblocked at the hub: the next check fetches new credentials.
    c = await service.refresh(null, hub.fetch);
    assert.equal(c.status, 'active');
    assert.ok(hubConfig());

    const { hubInformed } = await service.disconnect(actor, hub.fetch);
    assert.equal(hubInformed, true);
    c = await getHubConnection();
    assert.equal(c.status, 'off');
    assert.equal(c.hasPrivateKey, false);
    assert.equal(hubConfig(), null);

    const actions = (await query("SELECT action FROM audit_log WHERE actor_id = $1 AND action LIKE 'hub.connection.%' ORDER BY created_at, id", [actor])).rows.map((r) => r.action);
    assert.deepEqual(actions, ['hub.connection.enabled', 'hub.connection.applied', 'hub.connection.domain_verified', 'hub.connection.connected',
      'hub.connection.secret_rotated', 'hub.connection.disconnected']);

    // Switching the add-on off ends everything and keeps it from talking to the hub.
    await service.setEnabled(false, actor, hub.fetch);
    assert.equal((await getHubConnection()).enabled, false);
  } finally {
    server.close();
  }
});

test('environment configuration wins over the add-on', async () => {
  process.env.HUB_ISSUER = 'https://env.example/oidc';
  process.env.HUB_CLIENT_ID = 'qi_ffffffffffffffff';
  process.env.HUB_CLIENT_SECRET = 'env-secret';
  try {
    await service.setEnabled(true, null);
    await assert.rejects(service.apply(input, null, () => { throw new Error('no fetch'); }), /Umgebungsvariablen/);
    assert.equal(hubConfig().clientId, 'qi_ffffffffffffffff');
  } finally {
    for (const k of ['HUB_ISSUER', 'HUB_CLIENT_ID', 'HUB_CLIENT_SECRET']) delete process.env[k];
    await service.setEnabled(false, null);
  }
});
