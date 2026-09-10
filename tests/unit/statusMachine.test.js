import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransition } from '../../backend/registrations/statusMachine.js';

test('pending -> confirmed via approve', () => {
  assert.equal(applyTransition('pending', 'approve'), 'confirmed');
});

test('pending -> cancelled via cancel', () => {
  assert.equal(applyTransition('pending', 'cancel'), 'cancelled');
});

test('confirmed -> checked_in via checkin', () => {
  assert.equal(applyTransition('confirmed', 'checkin'), 'checked_in');
});

test('confirmed -> cancelled via cancel', () => {
  assert.equal(applyTransition('confirmed', 'cancel'), 'cancelled');
});

test('checked_in -> checked_out via checkout', () => {
  assert.equal(applyTransition('checked_in', 'checkout'), 'checked_out');
});

test('checkout without a prior checkin is rejected', () => {
  assert.throws(() => applyTransition('confirmed', 'checkout'));
});

test('checkin before approval (from pending) is rejected', () => {
  assert.throws(() => applyTransition('pending', 'checkin'));
});

test('a second checkin is rejected', () => {
  assert.throws(() => applyTransition('checked_in', 'checkin'));
});

test('any transition from checked_out is rejected', () => {
  assert.throws(() => applyTransition('checked_out', 'checkin'));
  assert.throws(() => applyTransition('checked_out', 'checkout'));
});

test('any transition from cancelled is rejected', () => {
  assert.throws(() => applyTransition('cancelled', 'approve'));
  assert.throws(() => applyTransition('cancelled', 'checkin'));
});

test('the thrown error carries a machine-readable code', () => {
  try {
    applyTransition('confirmed', 'checkout');
    assert.fail('expected a throw');
  } catch (err) {
    assert.equal(err.code, 'INVALID_TRANSITION');
  }
});
