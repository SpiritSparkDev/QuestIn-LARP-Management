import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement, toCents } from '../../backend/bankReconcile/parse.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/bank/${name}`, import.meta.url), 'utf8');

test('toCents handles German and English numbers', () => {
  assert.equal(toCents('1.234,56'), 123456);
  assert.equal(toCents('-12,50'), -1250);
  assert.equal(toCents('12.5'), 1250);
  assert.equal(toCents('1.234'), 123400);
  assert.equal(toCents('45'), 4500);
  assert.equal(toCents('abc'), null);
});

test('Sparkasse CSV: BOM, quotes, German numbers, debits dropped', () => {
  const e = parseStatement(fixture('sparkasse.csv'));
  assert.deepEqual(e.map((x) => x.amountCents), [123456, 2000]);
  assert.equal(e[0].date, '2026-11-03');
  assert.equal(e[0].counterparty, 'Fiona Fantasie');
  assert.match(e[0].text, /^GUTSCHRIFT FX1\/2027 Fiona-Fantasie$/);
  assert.match(e[1].text, /"Con"/);
});

test('DKB CSV with preamble before the header', () => {
  const e = parseStatement(fixture('dkb.csv'));
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].date, e[0].amountCents, e[0].text], ['2026-11-03', 4500, 'FX1/2027 Hans-Beispiel']);
});

test('comma-separated CSV with quoted comma', () => {
  const e = parseStatement(fixture('comma.csv'));
  assert.deepEqual(e, [{ date: '2026-11-03', amountCents: 1250, text: 'FX1/2027 Ida-Illusion, danke', counterparty: 'Ida Illusion' }]);
});

test('CAMT.053 with namespace: credits only, several Ustrd joined, entities decoded', () => {
  const e = parseStatement(fixture('camt053.xml'));
  assert.deepEqual(e, [{ date: '2026-11-03', amountCents: 10000, text: 'FX1/2027 Boss-Gruppe: Lena, Tom', counterparty: 'Boss & Co' }]);
});

test('CAMT.053 with namespace prefix', () => {
  const xml = '<ns:Document><ns:Ntry><ns:Amt Ccy="EUR">5.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:BookgDt><ns:Dt>2026-01-02</ns:Dt></ns:BookgDt><ns:Ustrd>x</ns:Ustrd></ns:Ntry></ns:Document>';
  assert.equal(parseStatement(xml)[0].amountCents, 500);
});

test('empty or unreadable input throws a German error', () => {
  assert.throws(() => parseStatement('  '), /leer/);
  assert.throws(() => parseStatement('foo;bar\n1;2'), /Kopfzeile/);
  assert.throws(() => parseStatement('<xml/>'), /Ntry/);
});

test('MT940: credits only, structured purpose joined without separator, unstructured :86:', () => {
  const e = parseStatement(fixture('mt940.sta'));
  assert.equal(e.length, 2); // debit (D) and reversal (RC) dropped
  assert.deepEqual([e[0].date, e[0].amountCents, e[0].counterparty], ['2026-11-03', 6000, 'Hans Ueberweiser']);
  assert.equal(e[0].text, 'Beitrag FX1/2027 Fiona-Fantasie danke');
  assert.deepEqual([e[1].date, e[1].amountCents, e[1].text], ['2026-11-05', 2000, 'Spende fuer den Verein ohne Struktur']);
});

test('MT940: :86: continuation lines belong to the field; ?20-?29 and ?60-?63 are concatenated', () => {
  const [e] = parseStatement(fixture('mt940-wrap.sta'));
  assert.equal(e.text, 'Beitrag FX1/2027 Fiona-Fantasie danke');
  assert.equal(e.counterparty, 'Hans Ueberweiser');
  const [f] = parseStatement(':20:X\n:61:261103C1,00N\n:86:0?20abc?21def?60ghi?61jkl');
  assert.equal(f.text, 'abcdefghijkl');
});
