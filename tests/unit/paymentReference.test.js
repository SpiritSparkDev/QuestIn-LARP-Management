import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentReference } from '../../backend/payments/reference.js';

test('buildPaymentReference combines the first 8 chars of eventId and userId, uppercased', () => {
  assert.equal(
    buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    'P-11111111-AAAAAAAA'
  );
});

test('buildPaymentReference uses the QR code identifier plus Vorname-Nachname', () => {
  const ids = ['11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'];
  assert.equal(buildPaymentReference(...ids, { code: 'P17/2027', firstName: 'Anna', lastName: 'Muster' }), 'P17/2027 Anna-Muster');
  // no identifier -> the old id-based fallback
  assert.equal(buildPaymentReference(...ids, { code: null, firstName: 'Anna', lastName: 'Muster' }), 'P-11111111-AAAAAAAA');
});

test('buildPaymentReference fills an admin template with placeholders', () => {
  const ids = ['11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'];
  const who = { code: 'P17/2027', eventName: 'Pakyrion', role: 'nsc', firstName: 'Anna', lastName: 'Muster' };
  assert.equal(buildPaymentReference(...ids, { ...who, template: '{code} {rolle}: {vorname} {nachname} ({event})' }), 'P17/2027 NSC: Anna Muster (Pakyrion)');
  // unknown placeholders and missing values vanish without leaving double spaces
  assert.equal(buildPaymentReference(...ids, { ...who, code: null, template: '{code} {foo} {name}' }), 'Anna-Muster');
  // a template that renders empty falls back to the default
  assert.equal(buildPaymentReference(...ids, { ...who, template: '{foo}' }), 'P17/2027 Anna-Muster');
  assert.equal(buildPaymentReference(...ids, { ...who, template: '  ' }), 'P17/2027 Anna-Muster');
});

test('buildPaymentReference is stable for the same inputs', () => {
  const a = buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const b = buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(a, b);
});
