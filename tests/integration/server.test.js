import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';

const { createServer, router } = await import('../../backend/server.js');
const { closePool } = await import('../../backend/db.js');

test('GET /health returns ok and a request id header', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: 'ok' });
  assert.ok(res.headers.get('x-request-id'));
  server.close();
});

test('unknown route returns 404 with a request id', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.requestId);
  server.close();
});

test('a handler that throws produces a generic 500 without leaking internals', async () => {
  router.get('/__boom', async () => { throw new Error('kaboom internal detail'); });
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/__boom`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'internal server error');
  assert.ok(body.requestId);
  assert.ok(!JSON.stringify(body).includes('kaboom'));
  server.close();
});

test.after(async () => {
  await closePool();
});
