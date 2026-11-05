// Pure matching of statement entries against open payments.
// registrations: [{ eventId, userId, name, amountDueCents, reference }]
// groupPayments: [{ id, eventId, reference, userIds, names, amountCents }]  (only still-open people)

const DASHES = /[‐-―−]/g;
export const normalize = (s) => String(s ?? '').toLowerCase().replace(DASHES, '-').replace(/\s+/g, ' ').trim();
const WORD = /[\p{L}\p{N}]/u;

// The reference must not be a fragment of a longer word ("Anna-Muster" in "Anna-Mustermann").
// Spaces are ignored on both sides, so a space inserted mid-word by a bank still matches;
// the word-boundary check looks at the original characters around the match.
function contains(text, ref) {
  const r = String(ref ?? '').replace(/ /g, '');
  if (!r) return false;
  let compact = '';
  const at = []; // compact index -> index in text
  for (let i = 0; i < text.length; i++) if (text[i] !== ' ') { compact += text[i]; at.push(i); }
  for (let p = compact.indexOf(r); p >= 0; p = compact.indexOf(r, p + 1)) {
    const before = text[at[p] - 1], after = text[at[p + r.length - 1] + 1];
    if ((!before || !WORD.test(before)) && (!after || !WORD.test(after))) return true;
  }
  return false;
}

export function matchEntries(entries, { registrations = [], groupPayments = [] } = {}) {
  const candidates = [
    ...registrations.map((r) => ({ ref: normalize(r.reference), c: { kind: 'registration', eventId: r.eventId, userIds: [r.userId], names: [r.name], amountCents: r.amountDueCents } })),
    ...groupPayments.filter((g) => g.userIds.length).map((g) => ({ ref: normalize(g.reference), c: { kind: 'group', eventId: g.eventId, userIds: g.userIds, names: g.names, amountCents: g.amountCents, groupPaymentId: g.id } })),
  ];
  const taken = new Set(); // "eventId:userId" already covered by an earlier 'match'
  const keys = (c) => c.userIds.map((u) => `${c.eventId}:${u}`);

  return entries.map((entry, index) => {
    const text = normalize(entry.text);
    let hits = candidates.filter((x) => contains(text, x.ref));
    // A reference that is part of another hit (single "P1 Boss" inside group "P1 Boss: Lena") loses.
    hits = hits.filter((x) => !hits.some((y) => y.ref.length > x.ref.length && y.ref.includes(x.ref)));
    const list = hits.map((x) => ({ ...x.c, exact: x.c.amountCents === entry.amountCents }));
    let status = 'unmatched';
    if (list.length > 1) status = 'ambiguous';
    else if (list.length === 1) {
      if (!list[0].exact) status = 'amount_mismatch';
      else if (keys(list[0]).some((k) => taken.has(k))) status = 'duplicate';
      else { status = 'match'; keys(list[0]).forEach((k) => taken.add(k)); }
    }
    return { index, ...entry, status, candidates: list };
  });
}

export function summarize(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  return { total: results.length, match: count('match'), amountMismatch: count('amount_mismatch'), ambiguous: count('ambiguous'), unmatched: count('unmatched'), duplicate: count('duplicate') };
}
