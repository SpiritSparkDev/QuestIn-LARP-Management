import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hubEventStats, resetHubStatsCache } from '../../backend/hubDirectory/stats.js';

const ENV = ['HUB_ISSUER', 'HUB_CLIENT_ID', 'HUB_CLIENT_SECRET'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

function configure() {
  process.env.HUB_ISSUER = 'https://hub.example/oidc';
  process.env.HUB_CLIENT_ID = 'qi_0123456789abcdef';
  process.env.HUB_CLIENT_SECRET = 'geheim:mit/zeichen';
}

afterEach(() => {
  resetHubStatsCache();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('without hub configuration nothing is fetched', async () => {
  for (const k of ENV) delete process.env[k];
  const res = await hubEventStats(() => { throw new Error('must not fetch'); });
  assert.deepEqual(res, { enabled: false, events: {}, orgs: [] });
});

test('reads the stats with HTTP Basic, keeps only numbers and caches them', async () => {
  configure();
  let calls = 0;
  let seen;
  const fetchImpl = async (url, init) => {
    calls += 1;
    seen = { url: String(url), auth: init.headers.Authorization };
    return new Response(JSON.stringify({
      orgs: [{ name: 'Orga', slug: 'orga', events: [
        { externalId: 'ev-1', name: 'Con', views: 12, clicks: 3, last30Days: { views: 4, clicks: 1 } },
        { externalId: 'ev-2', views: -5, clicks: 'viele' },
        { externalId: 7 },
      ] }],
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  const res = await hubEventStats(fetchImpl, 1000);
  assert.equal(seen.url, 'https://hub.example/api/org/stats');
  assert.equal(seen.auth, `Basic ${Buffer.from('qi_0123456789abcdef:geheim%3Amit%2Fzeichen').toString('base64')}`);
  assert.deepEqual(res.orgs, [{ name: 'Orga', slug: 'orga' }]);
  assert.deepEqual(res.events['ev-1'], { views: 12, clicks: 3, last30Days: { views: 4, clicks: 1 } });
  assert.deepEqual(res.events['ev-2'], { views: 0, clicks: 0, last30Days: { views: 0, clicks: 0 } });
  assert.equal(Object.keys(res.events).length, 2);

  await hubEventStats(fetchImpl, 2000);
  assert.equal(calls, 1, 'cached for five minutes');
  await hubEventStats(fetchImpl, 1000 + 5 * 60 * 1000 + 1);
  assert.equal(calls, 2);
});

test('a failing hub is reported, not cached', async () => {
  configure();
  let calls = 0;
  const failing = async () => { calls += 1; return new Response('nope', { status: 502 }); };
  const res = await hubEventStats(failing, 1000);
  assert.equal(res.unavailable, true);
  await hubEventStats(failing, 1001);
  assert.equal(calls, 2);
});
