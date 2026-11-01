import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentReference, buildGroupPaymentReference } from '../../backend/payments/reference.js';

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

test('buildGroupPaymentReference fills placeholders, defaults, caps at 140 chars', () => {
  const ids = ['11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'];
  const who = { code: 'P17/2027', eventName: 'Pakyrion', payerFirstName: 'Andre', payerLastName: 'Muster', groupName: 'Drachenbande', personNames: ['Lena', 'Tom'] };
  assert.equal(
    buildGroupPaymentReference(...ids, { ...who, template: '{code} {gruppe} {zahler}: {personen} ({anzahl}) {event}' }),
    'P17/2027 Drachenbande Andre-Muster: Lena, Tom (2) Pakyrion'
  );
  // empty or blank-rendering template -> default
  assert.equal(buildGroupPaymentReference(...ids, who), 'P17/2027 Andre-Muster: Lena, Tom');
  assert.equal(buildGroupPaymentReference(...ids, { ...who, template: '{foo}' }), 'P17/2027 Andre-Muster: Lena, Tom');
  // no code -> no double or leading spaces
  assert.equal(buildGroupPaymentReference(...ids, { ...who, code: null }), 'Andre-Muster: Lena, Tom');
  assert.equal(buildGroupPaymentReference(...ids, { ...who, code: null, template: '{code} {gruppe}' }), 'Drachenbande');
  assert.equal(buildGroupPaymentReference(...ids, { ...who, template: '{id}' }), 'P-11111111-AAAAAAAA');
  const long = buildGroupPaymentReference(...ids, { ...who, personNames: Array.from({ length: 40 }, (_, i) => `Person${i}`) });
  assert.equal(long.length <= 140, true);
  assert.equal(long.length > 100, true);
});

test('buildPaymentReference is stable for the same inputs', () => {
  const a = buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const b = buildPaymentReference('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(a, b);
});
