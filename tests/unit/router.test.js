import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../backend/router.js';

test('matches an exact path', () => {
  const router = new Router();
  router.get('/health', () => 'ok');
  const match = router.match('GET', '/health');
  assert.ok(match);
  assert.equal(match.handler(), 'ok');
});

test('extracts path params', () => {
  const router = new Router();
  router.get('/events/:id', () => {});
  const match = router.match('GET', '/events/abc-123');
  assert.deepEqual(match.params, { id: 'abc-123' });
});

test('returns null for unmatched method', () => {
  const router = new Router();
  router.get('/health', () => {});
  assert.equal(router.match('POST', '/health'), null);
});

test('returns null for unmatched path', () => {
  const router = new Router();
  router.get('/health', () => {});
  assert.equal(router.match('GET', '/nope'), null);
});
