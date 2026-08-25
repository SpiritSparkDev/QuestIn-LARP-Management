import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../frontend/js/api.js';

test('get() resolves with the parsed JSON body on success', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const result = await api.get('/whatever');
  assert.deepEqual(result, { ok: true });
});

test('post() sends credentials, a JSON content-type, and a stringified body', async (t) => {
  let seenOptions;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seenOptions = options;
    return new Response(JSON.stringify({ created: true }), { status: 201 });
  });
  await api.post('/things', { name: 'x' });
  assert.equal(seenOptions.credentials, 'include');
  assert.equal(seenOptions.headers['Content-Type'], 'application/json');
  assert.equal(seenOptions.body, JSON.stringify({ name: 'x' }));
});

test('a non-ok response throws an Error carrying the status and parsed body', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'nope' }), { status: 400 }));
  await assert.rejects(api.get('/whatever'), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.message, 'nope');
    return true;
  });
});

test('a response with no JSON body does not crash', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 200 }));
  const result = await api.get('/whatever');
  assert.equal(result, null);
});
