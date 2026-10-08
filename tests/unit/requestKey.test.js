import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestKeys, newRequestId } from '../../frontend/js/requestKey.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the same action keeps its key until it is done', () => {
  const keys = createRequestKeys();
  const first = keys.get('acc|2x beer');
  assert.match(first, UUID);
  assert.equal(keys.get('acc|2x beer'), first);
  assert.notEqual(keys.get('acc|1x mead'), first);
  const mead = keys.get('acc|1x mead');
  keys.done();
  assert.notEqual(keys.get('acc|1x mead'), mead);
});

test('works without crypto.randomUUID (insecure context)', (t) => {
  const real = globalThis.crypto;
  t.mock.getter(globalThis, 'crypto', () => ({ getRandomValues: real.getRandomValues.bind(real) }));
  assert.match(newRequestId(), UUID);
});
