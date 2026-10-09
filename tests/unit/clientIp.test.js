import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../../backend/middleware/rateLimit.js';

const req = (forwarded, socket = '172.18.0.1') => ({ socket: { remoteAddress: socket }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

test('without TRUST_PROXY the socket address counts, a forwarded header is ignored', () => {
  delete process.env.TRUST_PROXY;
  assert.equal(clientIp(req('203.0.113.7')), '172.18.0.1');
});

test('with one trusted proxy the last forwarded entry is the visitor; entries a visitor adds in front are ignored', () => {
  process.env.TRUST_PROXY = '1';
  try {
    assert.equal(clientIp(req('203.0.113.7')), '203.0.113.7');
    assert.equal(clientIp(req('6.6.6.6, 203.0.113.7')), '203.0.113.7'); // spoofed prefix
    assert.equal(clientIp(req(undefined)), '172.18.0.1'); // no header: fall back to the socket
  } finally {
    delete process.env.TRUST_PROXY;
  }
});

test('with two trusted proxies the second-to-last entry is the visitor', () => {
  process.env.TRUST_PROXY = '2';
  try {
    assert.equal(clientIp(req('203.0.113.7, 10.0.0.5')), '203.0.113.7');
    assert.equal(clientIp(req('10.0.0.5')), '172.18.0.1'); // fewer entries than proxies: do not guess
  } finally {
    delete process.env.TRUST_PROXY;
  }
});

test('RATE_LIMIT_DISABLED lets every call through, otherwise the limit applies', async () => {
  const { rateLimit, resetRateLimits } = await import('../../backend/middleware/rateLimit.js');
  resetRateLimits();
  const limited = rateLimit({ keyPrefix: 'unit-disabled', maxAttempts: 2, windowMs: 60_000 })(async () => ({ status: 200 }));
  const call = () => limited({ req: req('203.0.113.7') });

  delete process.env.RATE_LIMIT_DISABLED;
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);

  process.env.RATE_LIMIT_DISABLED = '1';
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await call()).status, 200);
  } finally {
    delete process.env.RATE_LIMIT_DISABLED;
    resetRateLimits();
  }
});
