import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotkeyMatches, hotkeyFromEvent, hotkeyLabel, isReservedHotkey, sameHotkey } from '../../frontend/js/hotkeys.js';
import { hotkeysError } from '../../backend/accounts/hotkeys.js';

const ev = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('legacy string ignores modifiers (unchanged behaviour)', () => {
  assert.ok(hotkeyMatches('Enter', ev('Enter')));
  assert.ok(hotkeyMatches('Enter', ev('Enter', { ctrlKey: true })));
  assert.ok(!hotkeyMatches('Enter', ev('Escape')));
});

test('object spec compares key and modifiers exactly', () => {
  const spec = { key: 'k', ctrl: true, alt: true };
  assert.ok(hotkeyMatches(spec, ev('k', { ctrlKey: true, altKey: true })));
  assert.ok(hotkeyMatches(spec, ev('K', { ctrlKey: true, altKey: true })));
  assert.ok(!hotkeyMatches(spec, ev('k', { ctrlKey: true })));
  assert.ok(!hotkeyMatches(spec, ev('k', { ctrlKey: true, altKey: true, shiftKey: true })));
  assert.ok(!hotkeyMatches({ key: 'k', ctrl: true }, ev('k')));
});

test('capture stores plain keys as strings, modified keys as objects', () => {
  assert.equal(hotkeyFromEvent(ev('Enter')), 'Enter');
  assert.equal(hotkeyFromEvent(ev('K', { shiftKey: true })), 'K');
  assert.deepEqual(hotkeyFromEvent(ev('k', { ctrlKey: true, altKey: true })), { key: 'k', ctrl: true, alt: true });
});

test('labels, reserved combos and duplicates', () => {
  assert.equal(hotkeyLabel({ key: 'k', ctrl: true, alt: true }), 'Strg+Alt+K');
  assert.equal(hotkeyLabel(' '), 'Leertaste');
  assert.ok(isReservedHotkey({ key: 'w', ctrl: true }));
  assert.ok(isReservedHotkey({ key: 'F4', alt: true }));
  assert.ok(isReservedHotkey('F5'));
  assert.ok(!isReservedHotkey({ key: 'k', ctrl: true }));
  assert.ok(sameHotkey('k', { key: 'K' }));
  assert.ok(!sameHotkey('k', { key: 'k', ctrl: true }));
});

test('hotkeysError validates the stored format', () => {
  assert.equal(hotkeysError(undefined), null);
  assert.equal(hotkeysError(null), null);
  assert.equal(hotkeysError({ confirm: 'Enter', scan: { key: 'k', ctrl: true } }), null);
  for (const bad of ['x', [], { confirm: 5 }, { confirm: { key: 'k', meta: true } }, { confirm: { key: 'k', ctrl: 'yes' } }, { confirm: { ctrl: true } }, { bogus: 'k' }, { confirm: '' }]) {
    assert.notEqual(hotkeysError(bad), null, JSON.stringify(bad));
  }
});
