import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierRangeLabel, currentTierName, renderPriceTable } from '../../frontend/js/priceTable.js';

const pricing = {
  groups: ['Spieler', 'Kinder'],
  tiers: [
    { name: 'Frühbucher', until: '2027-01-01', amounts: { Spieler: 26000, Kinder: 16000 } },
    { name: 'Standard', until: '2027-07-01', amounts: { Spieler: 27000, Kinder: 17500 } },
    { name: 'Vor Ort', until: null, conPayer: true, amounts: { Spieler: 29000, Kinder: 19500 } },
  ],
};

test('stage date ranges chain from the previous deadline', () => {
  assert.equal(tierRangeLabel(pricing.tiers, 0), 'bis 01.01.2027');
  assert.equal(tierRangeLabel(pricing.tiers, 1), '02.01.2027 – 01.07.2027');
  assert.equal(tierRangeLabel(pricing.tiers, 2), 'ab 02.07.2027');
  assert.equal(tierRangeLabel([{ name: 'A', until: null }], 0), 'ohne Frist');
});

test('current stage is the first one whose deadline is not over', () => {
  assert.equal(currentTierName(pricing.tiers, '2026-12-31'), 'Frühbucher');
  assert.equal(currentTierName(pricing.tiers, '2027-01-02'), 'Standard');
  assert.equal(currentTierName(pricing.tiers, '2028-01-01'), 'Vor Ort');
});

test('table has the dates in the header and the group prices in the second row', () => {
  const html = renderPriceTable(pricing, 'Kinder', { highlight: 'Standard' });
  assert.match(html, /<thead><tr>.*Frühbucher.*bis 01\.01\.2027.*Standard.*Vor Ort.*Zahlung vor Ort/s);
  assert.match(html, /160,00\s€.*175,00\s€.*195,00\s€/s);
  assert.equal((html.match(/is-current/g) ?? []).length, 2);
  assert.equal(renderPriceTable(pricing, ''), '');
  assert.equal(renderPriceTable(pricing, 'Unbekannt'), '');
  assert.equal(renderPriceTable({ groups: ['A'], tiers: [] }, 'A'), '');
});
