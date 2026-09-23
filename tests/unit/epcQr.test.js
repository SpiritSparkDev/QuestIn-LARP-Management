import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEpcQrPayload } from '../../frontend/js/epcQr.js';

test('buildEpcQrPayload produces the 12-line EPC069-12 SCT payload', () => {
  const payload = buildEpcQrPayload({
    iban: 'DE02100100100006820101',
    bic: 'PBNKDEFF',
    name: 'Pakyrion e.V.',
    amountCents: 4250,
    reference: 'P-11111111-AAAAAAAA',
  });
  assert.deepEqual(payload.split('\n'), [
    'BCD', '002', '1', 'SCT', 'PBNKDEFF', 'Pakyrion e.V.', 'DE02100100100006820101',
    'EUR42.50', '', '', 'P-11111111-AAAAAAAA', '',
  ]);
});

test('buildEpcQrPayload formats whole-euro amounts with two decimal places', () => {
  const payload = buildEpcQrPayload({
    iban: 'DE02100100100006820101', bic: '', name: 'Pakyrion e.V.',
    amountCents: 5000, reference: 'P-1',
  });
  assert.match(payload, /\nEUR50\.00\n/);
});
