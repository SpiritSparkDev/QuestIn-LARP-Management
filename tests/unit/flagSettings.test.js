import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagDiscountCents, normalizeFlagSettings, validateFlagSettings } from '../../backend/events/flagSettings.js';

const settings = {
  Ersthelfer: { abbr: 'ERS', discount: { type: 'percent', value: 25 } },
  VP: { discount: { type: 'amount', value: 3000 } },
  GSC: { discount: { type: 'free' } },
};

test('flagDiscountCents: percent, amount, free', () => {
  assert.equal(flagDiscountCents(settings, ['Ersthelfer'], 10000), 2500);
  assert.equal(flagDiscountCents(settings, ['VP'], 10000), 3000);
  assert.equal(flagDiscountCents(settings, ['GSC'], 10000), 10000);
});

test('flagDiscountCents: amount capped at the price, best discount wins, no price = no discount', () => {
  assert.equal(flagDiscountCents(settings, ['VP'], 2000), 2000);
  assert.equal(flagDiscountCents(settings, ['Ersthelfer', 'VP'], 10000), 3000);
  assert.equal(flagDiscountCents(settings, ['GSC'], null), 0);
  assert.equal(flagDiscountCents(settings, ['Unbekannt'], 10000), 0);
});

test('validateFlagSettings: abbr max 10, percent 1-100', () => {
  assert.equal(validateFlagSettings(settings), null);
  assert.ok(validateFlagSettings({ A: { abbr: 'ABCDEFGHIJK' } }));
  assert.ok(validateFlagSettings({ A: { discount: { type: 'percent', value: 101 } } }));
  assert.ok(validateFlagSettings({ A: { discount: { type: 'amount', value: 0 } } }));
  assert.ok(validateFlagSettings({ A: { discount: { type: 'bogus' } } }));
});

test('normalizeFlagSettings: only existing flags, trimmed', () => {
  assert.deepEqual(normalizeFlagSettings({ A: { abbr: ' ab ' }, X: { abbr: 'x' } }, ['A']), { A: { abbr: 'ab' } });
});
