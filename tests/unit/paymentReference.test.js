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

test('buildPaymentReference is stable for the same inputs', () => {
  const a = buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const b = buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(a, b);
});
