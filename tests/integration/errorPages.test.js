import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();
const { closePool } = await import('../../backend/db.js');

const html = { Accept: 'text/html' };

test('an unknown page gets the 404 page, an unknown API path stays JSON', async () => {
  await withTestServer(async (port) => {
    const page = await fetch(`http://localhost:${port}/gibt-es-nicht.html`, { headers: html });
    assert.equal(page.status, 404);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Diese Seite gibt es nicht/);

    const api = await fetch(`http://localhost:${port}/gibt-es-nicht-api`);
    assert.equal(api.status, 404);
    assert.match(api.headers.get('content-type'), /application\/json/);
  });
});

test('a browser opening an API address gets a readable error page; our own fetch calls keep getting JSON', async () => {
  await withTestServer(async (port) => {
    const base = `http://localhost:${port}`;
    const page = await fetch(`${base}/account`, { headers: html });
    assert.equal(page.status, 401);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const text = await page.text();
    assert.match(text, /Bitte melde dich an/);
    assert.match(text, />401</);
    assert.doesNotMatch(text, /\{\{/); // every placeholder was filled

    const api = await fetch(`${base}/account`, { headers: { Accept: '*/*' } });
    assert.equal(api.status, 401);
    assert.match(api.headers.get('content-type'), /application\/json/);
  });
});

test('every status has a page: known ones with their own text, the rest by class (4xx / 5xx)', async () => {
  const { renderErrorPage } = await import('../../backend/errorPages.js');
  const text = async (status) => (await renderErrorPage(status)).data.toString('utf8');
  assert.match(await text(403), /Kein Zugriff/);
  assert.match(await text(500), /Da ist etwas schiefgegangen/);
  assert.match(await text(418), /Anfrage nicht möglich/);
  assert.match(await text(507), /Serverfehler/);
});

test('maintenance mode: pages show the 503 page, the API answers 503, assets and /health stay up', async () => {
  process.env.MAINTENANCE_MODE = '1';
  try {
    await withTestServer(async (port) => {
      const base = `http://localhost:${port}`;
      const page = await fetch(`${base}/account.html`, { headers: html });
      assert.equal(page.status, 503);
      assert.equal(page.headers.get('retry-after'), '600');
      assert.match(await page.text(), /Wir sind gleich wieder da/);

      const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(login.status, 503);
      assert.equal((await login.json()).maintenance, true);

      assert.equal((await fetch(`${base}/css/sahara.css`)).status, 200);
      assert.equal((await fetch(`${base}/app-settings`)).status, 200);
      assert.equal((await fetch(`${base}/health`)).status, 200);
    });
  } finally {
    delete process.env.MAINTENANCE_MODE;
  }
  // and back to normal
  await withTestServer(async (port) => {
    assert.notEqual((await fetch(`http://localhost:${port}/login.html`, { headers: html })).status, 503);
  });
});

test.after(async () => {
  await closePool();
});
