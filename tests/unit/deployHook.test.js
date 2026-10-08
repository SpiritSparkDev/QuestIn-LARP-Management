import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const script = new URL('../../scripts/deploy-hook.sh', import.meta.url).pathname;

function run(env) {
  return new Promise((resolve) => {
    const child = spawn('sh', [script], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function withServer(handler, fn) {
  const calls = [];
  const server = http.createServer((req, res) => { calls.push(`${req.method} ${req.url}`); handler(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    server.close();
  }
}

test('skips quietly when no hook URL is configured', async () => {
  const { code, out } = await run({});
  assert.equal(code, 0);
  assert.match(out, /skipping/);
});

test('POSTs the hook and succeeds on 2xx without printing the URL', async () => {
  await withServer((req, res) => { res.statusCode = 204; res.end(); }, async (base, calls) => {
    const hook = `${base}/api/stacks/webhooks/secret-id`;
    const { code, out } = await run({ DEPLOY_HOOK_URL: hook });
    assert.equal(code, 0, out);
    assert.deepEqual(calls, ['POST /api/stacks/webhooks/secret-id']);
    assert.ok(!out.includes('secret-id'));
  });
});

test('fails loudly on a 404 from the hook', async () => {
  await withServer((req, res) => { res.statusCode = 404; res.end(); }, async (base) => {
    const { code, out } = await run({ DEPLOY_HOOK_URL: `${base}/hook` });
    assert.equal(code, 1);
    assert.match(out, /HTTP 404/);
  });
});

test('waits until /health reports the expected version', async () => {
  let hits = 0;
  await withServer((req, res) => {
    if (req.method === 'POST') { res.statusCode = 204; res.end(); return; }
    hits += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', version: hits < 3 ? '0.1.0' : '0.2.0' }));
  }, async (base) => {
    const { code, out } = await run({
      DEPLOY_HOOK_URL: `${base}/hook`,
      DEPLOY_HEALTH_URL: `${base}/health`,
      EXPECTED_VERSION: '0.2.0',
      HEALTH_INTERVAL: '1',
      HEALTH_TIMEOUT: '20',
    });
    assert.equal(code, 0, out);
    assert.match(out, /version 0\.2\.0/);
  });
});

test('fails when the expected version never shows up', async () => {
  await withServer((req, res) => {
    if (req.method === 'POST') { res.statusCode = 204; res.end(); return; }
    res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
  }, async (base) => {
    const { code, out } = await run({
      DEPLOY_HOOK_URL: `${base}/hook`,
      DEPLOY_HEALTH_URL: `${base}/health`,
      EXPECTED_VERSION: '9.9.9',
      HEALTH_INTERVAL: '1',
      HEALTH_TIMEOUT: '2',
    });
    assert.equal(code, 1);
    assert.match(out, /timed out/);
  });
});
