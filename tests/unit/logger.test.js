import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../backend/logger.js';

test('logs at info level by default and includes context', (t) => {
  process.env.LOG_LEVEL = 'info';
  const calls = t.mock.method(console, 'log');
  logger.info('hello', { userId: '123' });
  assert.equal(calls.mock.calls.length, 1);
  const line = JSON.parse(calls.mock.calls[0].arguments[0]);
  assert.equal(line.level, 'info');
  assert.equal(line.msg, 'hello');
  assert.equal(line.userId, '123');
  assert.ok(line.ts);
});

test('debug is suppressed when LOG_LEVEL=info', (t) => {
  process.env.LOG_LEVEL = 'info';
  const calls = t.mock.method(console, 'log');
  logger.debug('should not appear');
  assert.equal(calls.mock.calls.length, 0);
});

test('debug is shown when LOG_LEVEL=debug', (t) => {
  process.env.LOG_LEVEL = 'debug';
  const calls = t.mock.method(console, 'log');
  logger.debug('now visible');
  assert.equal(calls.mock.calls.length, 1);
});

test('warn and error go to console.error', (t) => {
  process.env.LOG_LEVEL = 'debug';
  const calls = t.mock.method(console, 'error');
  logger.warn('careful');
  logger.error('boom');
  assert.equal(calls.mock.calls.length, 2);
});
