import { test } from 'node:test';
import assert from 'node:assert/strict';

const { csvCell, toCsv } = await import('../../frontend/js/csv.js');

test('csvCell quotes separators, quotes and line breaks, and renders arrays and booleans readably', () => {
  assert.equal(csvCell('Müller'), 'Müller');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('sie sagte "hi"'), '"sie sagte ""hi"""');
  assert.equal(csvCell('zwei\nZeilen'), '"zwei\nZeilen"');
  assert.equal(csvCell(['GSC', 'VP']), 'GSC, VP');
  assert.equal(csvCell(true), 'Ja');
  assert.equal(csvCell(false), 'Nein');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');
});

test('csvCell defuses spreadsheet formulas', () => {
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvCell('+49 151 1234'), "'+49 151 1234");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('@home'), "'@home");
  assert.equal(csvCell('a=b'), 'a=b');
});

test('toCsv writes a BOM, a header line and ;-separated CRLF rows', () => {
  const csv = toCsv([{ n: 'Ann', t: 'x;y' }, { n: 'Bo', t: '' }], [
    { label: 'Name', value: (r) => r.n },
    { label: 'Text', value: (r) => r.t },
  ]);
  assert.equal(csv, '﻿Name;Text\r\nAnn;"x;y"\r\nBo;\r\n');
});
