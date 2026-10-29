import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.FUNKE_INSECURE_HOMESERVER = '1';

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();
const { query, closePool } = await import('../../backend/db.js');
const { setAppSettings } = await import('../../backend/appSettings/repository.js');
const { hashPassword } = await import('../../backend/crypto/password.js');
const { withTestServer } = await import('../testServer.js');

// Stub homeserver: token "good-<localpart>" belongs to @<localpart>:<its own host>.
const hs = http.createServer((req, res) => {
  const token = new URL(req.url, 'http://x').searchParams.get('access_token') ?? '';
  if (!token.startsWith('good-')) { res.writeHead(401).end('{}'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sub: `@${token.slice(5)}:${req.headers.host}` }));
}).listen(0);
const server = `localhost:${hs.address().port}`;

const login = (port, body, headers = {}) => fetch(`http://localhost:${port}/auth/matrix`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ server, ...body }),
});

test('Funke add-on: off = 404, on = Matrix login with link / create / bearer auth / CORS', async () => {
  await withTestServer(async (port) => {
    await setAppSettings({ funkeEnabled: false });
    assert.equal((await login(port, { token: 'good-anna' })).status, 404);

    await setAppSettings({ funkeEnabled: true, funkeHomeservers: [], funkeOrigin: 'https://funke.example.org' });
    assert.equal((await login(port, { token: 'good-anna' })).status, 403, 'server not on allowlist');

    await setAppSettings({ funkeHomeservers: [server] });
    assert.equal((await login(port, { token: 'bad' })).status, 401, 'homeserver rejects token');
    const unknown = await login(port, { token: `good-${crypto.randomUUID().slice(0, 8)}` });
    assert.equal(unknown.status, 409, 'unknown Matrix id must choose link or create');

    // link an existing account with email + password
    const email = `funke-${crypto.randomUUID()}@example.com`;
    await query(
      "INSERT INTO users (email, password_hash, first_name, last_name, group_id, email_verified) VALUES ($1, $2, 'Anna', 'Test', (SELECT id FROM groups WHERE key = 'mitglied'), true)",
      [email, await hashPassword('geheim-123')],
    );
    const bad = await login(port, { token: 'good-anna', email, password: 'falsch' });
    assert.equal(bad.status, 401);
    const linked = await login(port, { token: 'good-anna', email, password: 'geheim-123' });
    assert.equal(linked.status, 200);
    const { token: bearer, userId } = await linked.json();

    // the same Matrix id now logs in without credentials, as the same user
    assert.equal((await (await login(port, { token: 'good-anna' })).json()).userId, userId);

    // Bearer works on a normal route, but not when the add-on is off
    const me = () => fetch(`http://localhost:${port}/account`, { headers: { Authorization: `Bearer ${bearer}` } });
    assert.equal((await me()).status, 200);

    // createNew
    const created = await login(port, { token: `good-bob${Date.now()}`, createNew: true, name: 'Bob Test' });
    assert.equal(created.status, 200);

    // CORS only for the configured origin
    const pre = await fetch(`http://localhost:${port}/account`, { method: 'OPTIONS', headers: { Origin: 'https://funke.example.org' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://funke.example.org');
    const other = await fetch(`http://localhost:${port}/account`, { headers: { Origin: 'https://evil.example.org' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);

    await setAppSettings({ funkeEnabled: false });
    assert.equal((await me()).status, 401, 'Bearer ignored when add-on is off');
  });
  await setAppSettings({ funkeEnabled: false, funkeHomeservers: [], funkeOrigin: '' }); // keep app_settings defaults for other tests
  hs.close();
  await closePool();
});
