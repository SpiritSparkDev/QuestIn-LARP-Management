import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SMTP_HOST;

const { createServer } = await import('../../backend/server.js');
const { closePool } = await import('../../backend/db.js');

const FRONTEND_DIR = path.join(process.cwd(), 'frontend');

test('GET / serves frontend/index.html', async () => {
  // Assert against the real committed index.html rather than writing a fixture
  // over it — an earlier version of this test unlinked the file afterwards and
  // destroyed it on every `npm test` run.
  const expected = await readFile(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await res.text(), expected);
  server.close();
});

test('GET /does-not-exist.html returns 404, not a crash', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/does-not-exist.html`);
  assert.equal(res.status, 404);
  server.close();
});

test('an unmatched API-shaped path still returns the normal JSON 404', async () => {
  const server = createServer().listen(0);
  const { port } = server.address();
  const res = await fetch(`http://localhost:${port}/auth/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.requestId);
  server.close();
});

test.after(async () => {
  await closePool();
});
