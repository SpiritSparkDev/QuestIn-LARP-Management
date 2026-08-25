import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../../backend/httpBody.js';

test('parses a JSON body', async () => {
  const req = Readable.from([Buffer.from(JSON.stringify({ a: 1 }))]);
  assert.deepEqual(await readJsonBody(req), { a: 1 });
});

test('an empty body resolves to an empty object', async () => {
  const req = Readable.from([]);
  assert.deepEqual(await readJsonBody(req), {});
});

test('invalid JSON resolves to null', async () => {
  const req = Readable.from([Buffer.from('not json')]);
  assert.equal(await readJsonBody(req), null);
});

test('a body over the size cap resolves to null', async () => {
  const req = Readable.from([Buffer.alloc(1_000_001, 'a')]);
  assert.equal(await readJsonBody(req), null);
});
