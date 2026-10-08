import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, sideBySide } from '../../frontend/js/syncDiff.js';

test('flatten builds dotted and indexed keys', () => {
  assert.deepEqual(flatten({ a: { b: 1 }, c: [2, { d: null }] }), { 'a.b': '1', 'c[0]': '2', 'c[1].d': '–' });
});

test('sideBySide marks only differing and one-sided keys', () => {
  const rows = sideBySide({ kind: 'registration', status: 'checked_in', x: 1 }, { kind: 'registration', status: 'cancelled' });
  assert.deepEqual(rows.map((r) => [r.key, r.differs]), [['kind', false], ['status', true], ['x', true]]);
});
