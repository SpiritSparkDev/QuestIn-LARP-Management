import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEntries, summarize } from '../../backend/bankReconcile/match.js';

const reg = (userId, name, ref, cents = 5000, eventId = 'e1') => ({ eventId, userId, name, amountDueCents: cents, reference: ref });
const entry = (text, amountCents = 5000) => ({ date: null, amountCents, text, counterparty: '' });
const registrations = [
  reg('u1', 'Anna', 'P1/2027 Anna-Muster'),
  reg('u2', 'Bert', 'P1/2027 Bert-Beispiel'),
  reg('u3', 'Cleo', 'SC Cleo-Test'),
  reg('u4', 'Cleo2', 'SC Cleo-Test', 5000, 'e2'),
];
const groupPayments = [{ id: 'g1', eventId: 'e1', reference: 'P1/2027 Boss-Gruppe: Lena, Tom', userIds: ['u5', 'u6'], names: ['Lena', 'Tom'], amountCents: 10000 }];
const run = (entries, extra = {}) => matchEntries(entries, { registrations, groupPayments, ...extra });

test('every status', () => {
  const r = run([
    entry('Beitrag p1/2027  ANNA–Muster danke'), // match (case, whitespace, en dash)
    entry('P1/2027 Bert-Beispiel', 4000), // amount_mismatch
    entry('SC Cleo-Test'), // ambiguous
    entry('nix'), // unmatched
    entry('P1/2027 Anna-Muster'), // duplicate
    entry('P1/2027 Anna-Mustermann'), // not a fragment match
  ]);
  assert.deepEqual(r.map((x) => x.status), ['match', 'amount_mismatch', 'ambiguous', 'unmatched', 'duplicate', 'unmatched']);
  assert.deepEqual(summarize(r), { total: 6, match: 1, amountMismatch: 1, ambiguous: 1, unmatched: 2, duplicate: 1 });
  assert.equal(r[0].candidates[0].userIds[0], 'u1');
  assert.equal(r[2].candidates.length, 2);
});

test('group reference matches all people; group wins over a single reference it contains', () => {
  const r = run([entry('P1/2027 Boss-Gruppe: Lena, Tom', 10000)], {
    registrations: [...registrations, reg('u9', 'Boss', 'P1/2027 Boss-Gruppe')],
  });
  assert.equal(r[0].status, 'match');
  assert.deepEqual(r[0].candidates[0], { kind: 'group', eventId: 'e1', userIds: ['u5', 'u6'], names: ['Lena', 'Tom'], amountCents: 10000, groupPaymentId: 'g1', exact: true });
});

test('a person covered by a matched entry cannot be matched again by a group entry', () => {
  const r = run([entry('P1/2027 Lena-X'), entry('P1/2027 Boss-Gruppe: Lena, Tom', 10000)], {
    registrations: [reg('u5', 'Lena', 'P1/2027 Lena-X', 5000)],
  });
  assert.deepEqual(r.map((x) => x.status), ['match', 'duplicate']);
});

test('role placeholder references are matched verbatim', () => {
  const r = matchEntries([entry('SC Dora-Demo')], { registrations: [reg('u7', 'Dora', 'SC Dora-Demo')] });
  assert.equal(r[0].status, 'match');
});

test('a space inserted mid-word still matches; word boundaries are kept', () => {
  const r = run([
    entry('Beitrag P1/2027 Anna-Mu ster danke'), // match
    entry('P1/2027 Anna-Mu stermann'), // fragment of a longer word: no match
    entry('xP1/2027 Anna-Muster'), // letter directly before: no match
    entry('P1/2027 Ber t-Beis piel', 4000), // wrapped + amount mismatch
  ]);
  assert.deepEqual(r.map((x) => x.status), ['match', 'unmatched', 'unmatched', 'amount_mismatch']);
});

test('space-insensitive matching: the longer group reference still wins', () => {
  const r = run([entry('P1/2027 Boss-Gru ppe: Le na, Tom', 10000)], {
    registrations: [...registrations, reg('u9', 'Boss', 'P1/2027 Boss-Gruppe')],
  });
  assert.equal(r[0].status, 'match');
  assert.equal(r[0].candidates[0].kind, 'group');
});
