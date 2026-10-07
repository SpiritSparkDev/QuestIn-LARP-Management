import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageAt, ruleMatches, suggestPriceGroup, describeRule, describeRules, opsForType, rulesOf, PARTICIPATION_FIELDS } from '../../frontend/js/priceGroupRules.js';

const birth = { key: 'birthdate', label: 'Geburtsdatum', type: 'date' };

test('ageAt counts full years at the reference day', () => {
  assert.equal(ageAt('2015-08-24', '2027-08-24'), 12);
  assert.equal(ageAt('2015-08-25', '2027-08-24'), 11);
  assert.equal(ageAt('', '2027-08-24'), null);
});

test('rules by field type', () => {
  assert.equal(ruleMatches({ op: 'between', value: 6, value2: 11 }, birth, '2018-01-01', '2027-08-24'), true);
  assert.equal(ruleMatches({ op: 'between', value: 6, value2: 11 }, birth, '2010-01-01', '2027-08-24'), false);
  assert.equal(ruleMatches({ op: 'gte', value: 12 }, birth, '2010-01-01', '2027-08-24'), true);
  assert.equal(ruleMatches({ op: 'gte', value: 12 }, birth, '', '2027-08-24'), false);
  assert.equal(ruleMatches({ op: 'lt', value: 3 }, { type: 'number' }, '2'), true);
  assert.equal(ruleMatches({ op: 'contains', value: 'helf' }, { type: 'text' }, 'Helferin'), true);
  assert.equal(ruleMatches({ op: 'filled' }, { type: 'text' }, '  '.trim()), false);
  assert.equal(ruleMatches({ op: 'eq', value: 'NSC' }, { type: 'select' }, 'NSC'), true);
  assert.equal(ruleMatches({ op: 'has', value: 'Schmied' }, { type: 'multiselect' }, ['Koch', 'Schmied']), true);
  assert.equal(ruleMatches({ op: 'eq', value: true }, { type: 'boolean' }, true), true);
  assert.equal(ruleMatches({ op: 'eq', value: false }, { type: 'boolean' }, undefined), true);
});

test('suggestPriceGroup takes the first matching group in list order', () => {
  const pricing = {
    groups: ['Kinder', 'Spieler', 'Frei'],
    groupRules: {
      Kinder: { source: 'account', field: 'birthdate', op: 'between', value: 6, value2: 11 },
      Spieler: { source: 'account', field: 'birthdate', op: 'gte', value: 12 },
    },
  };
  const schemas = { account: [birth], registration: [] };
  assert.equal(suggestPriceGroup(pricing, { account: { birthdate: '2018-05-05' } }, schemas, '2027-08-24'), 'Kinder');
  assert.equal(suggestPriceGroup(pricing, { account: { birthdate: '1990-05-05' } }, schemas, '2027-08-24'), 'Spieler');
  assert.equal(suggestPriceGroup(pricing, { account: {} }, schemas, '2027-08-24'), null);
  assert.equal(suggestPriceGroup({ groups: ['A'] }, {}, schemas, '2027-08-24'), null);
});

test('describeRule and opsForType', () => {
  assert.equal(describeRule({ op: 'between', value: 6, value2: 11 }, birth), 'Alter (Geburtsdatum) in Jahren zwischen 6 und 11');
  assert.ok(opsForType('number').length >= 5);
  assert.deepEqual(opsForType('document'), []);
});

test('up to three rules per group must ALL apply; SC/NSC is a rule source', () => {
  const pricing = {
    groups: ['NSC', 'Kinder', 'Spieler'],
    groupRules: {
      NSC: [{ source: 'participation', field: 'conRole', op: 'eq', value: 'NSC' }],
      Kinder: [
        { source: 'account', field: 'birthdate', op: 'between', value: 6, value2: 11 },
        { source: 'participation', field: 'conRole', op: 'eq', value: 'SC' },
      ],
      Spieler: { source: 'account', field: 'birthdate', op: 'gte', value: 12 },
    },
  };
  const schemas = { account: [birth], registration: [], participation: PARTICIPATION_FIELDS };
  const pick = (born, role) => suggestPriceGroup(pricing, { account: { birthdate: born }, participation: { conRole: role } }, schemas, '2027-08-24');
  assert.equal(pick('2018-05-05', 'SC'), 'Kinder');
  assert.equal(pick('2018-05-05', 'NSC'), 'NSC');
  assert.equal(pick('1990-05-05', 'SC'), 'Spieler');
  assert.deepEqual(rulesOf(pricing.groupRules.Spieler).length, 1);
  assert.equal(describeRules(pricing.groupRules.Kinder, schemas), 'Alter (Geburtsdatum) in Jahren zwischen 6 und 11 und Teilnahme als ist SC');
});
