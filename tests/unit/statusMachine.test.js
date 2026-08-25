import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransition } from '../../backend/registrations/statusMachine.js';

test('registered -> checked_in via checkin', () => {
  assert.equal(applyTransition('registered', 'checkin'), 'checked_in');
});

test('checked_in -> checked_out via checkout', () => {
  assert.equal(applyTransition('checked_in', 'checkout'), 'checked_out');
});

test('checkout without a prior checkin is rejected', () => {
  assert.throws(() => applyTransition('registered', 'checkout'), /INVALID_TRANSITION|invalid transition/);
});

test('a second checkin is rejected', () => {
  assert.throws(() => applyTransition('checked_in', 'checkin'));
});

test('any transition from checked_out is rejected', () => {
  assert.throws(() => applyTransition('checked_out', 'checkin'));
  assert.throws(() => applyTransition('checked_out', 'checkout'));
});

test('the thrown error carries a machine-readable code', () => {
  try {
    applyTransition('registered', 'checkout');
    assert.fail('expected a throw');
  } catch (err) {
    assert.equal(err.code, 'INVALID_TRANSITION');
  }
});
