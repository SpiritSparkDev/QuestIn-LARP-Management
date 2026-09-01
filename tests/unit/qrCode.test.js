import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanCode, parseScanCode } from '../../frontend/js/qrCode.js';

test('buildScanCode joins the three parts with hyphens', () => {
  assert.equal(
    buildScanCode({ eventCode: 'P17/2027', groupKey: 'sc', userId: '11111111-2222-3333-4444-555555555555' }),
    'P17/2027-sc-11111111-2222-3333-4444-555555555555'
  );
});

test('parseScanCode round-trips a code built by buildScanCode', () => {
  const parts = { eventCode: 'P17/2027', groupKey: 'sc', userId: '11111111-2222-3333-4444-555555555555' };
  assert.deepEqual(parseScanCode(buildScanCode(parts)), parts);
});

test('parseScanCode handles an eventCode that itself contains a hyphen', () => {
  const parts = { eventCode: 'Con-2027', groupKey: 'hilfs_sl', userId: '11111111-2222-3333-4444-555555555555' };
  assert.deepEqual(parseScanCode(buildScanCode(parts)), parts);
});

test('parseScanCode rejects non-strings, empty strings, and strings without a valid trailing UUID', () => {
  assert.equal(parseScanCode(null), null);
  assert.equal(parseScanCode(''), null);
  assert.equal(parseScanCode('P17/2027-sc-not-a-uuid'), null);
  assert.equal(parseScanCode('11111111-2222-3333-4444-555555555555'), null); // no eventCode/groupKey prefix at all
});

test('parseScanCode rejects a code with no groupKey segment', () => {
  assert.equal(parseScanCode('P17/2027-11111111-2222-3333-4444-555555555555'), null);
});
