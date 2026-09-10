import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, rateLimit } from '../../backend/middleware/rateLimit.js';

test('isRateLimited allows the first maxAttempts calls for a key, then blocks', () => {
  const key = 'test-key-1';
  for (let i = 0; i < 5; i++) {
    assert.equal(isRateLimited(key, 5, 60_000, 1000), false, `attempt ${i + 1} should be allowed`);
  }
  assert.equal(isRateLimited(key, 5, 60_000, 1000), true, 'the 6th attempt should be blocked');
});

test('isRateLimited resets the count after the window elapses', () => {
  const key = 'test-key-2';
  for (let i = 0; i < 3; i++) {
    isRateLimited(key, 3, 1000, 1000);
  }
  assert.equal(isRateLimited(key, 3, 1000, 1500), true, 'still within the window, should be blocked');
  assert.equal(isRateLimited(key, 3, 1000, 2500), false, 'window has elapsed, should be allowed again');
});

test('isRateLimited tracks different keys independently', () => {
  for (let i = 0; i < 5; i++) {
    isRateLimited('test-key-3a', 5, 60_000, 1000);
  }
  assert.equal(isRateLimited('test-key-3a', 5, 60_000, 1000), true, 'key-3a should be blocked');
  assert.equal(isRateLimited('test-key-3b', 5, 60_000, 1000), false, 'a different key should not be affected');
});

test('rateLimit middleware calls the handler when under the limit, and returns 429 when over it', async () => {
  const handler = async () => ({ status: 200, body: { ok: true } });
  const wrapped = rateLimit({ keyPrefix: `test-mw-${Date.now()}`, maxAttempts: 2, windowMs: 60_000 })(handler);
  const ctx = { req: { socket: { remoteAddress: '127.0.0.1' } } };

  const first = await wrapped(ctx);
  assert.equal(first.status, 200);
  const second = await wrapped(ctx);
  assert.equal(second.status, 200);
  const third = await wrapped(ctx);
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'Zu viele Anfragen. Bitte später erneut versuchen.');
});

test('rateLimit middleware tracks different IPs independently', async () => {
  const handler = async () => ({ status: 200, body: { ok: true } });
  const prefix = `test-mw-ip-${Date.now()}`;
  const wrapped = rateLimit({ keyPrefix: prefix, maxAttempts: 1, windowMs: 60_000 })(handler);

  const first = await wrapped({ req: { socket: { remoteAddress: '10.0.0.1' } } });
  assert.equal(first.status, 200);
  const second = await wrapped({ req: { socket: { remoteAddress: '10.0.0.1' } } });
  assert.equal(second.status, 429);
  const third = await wrapped({ req: { socket: { remoteAddress: '10.0.0.2' } } });
  assert.equal(third.status, 200, 'a different IP should have its own limit');
});
