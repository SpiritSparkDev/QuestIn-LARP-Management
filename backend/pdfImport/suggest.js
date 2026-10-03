// Guesses which app field each PDF field belongs to, from the field names.
// Three passes, strongest first, never giving one app field to two PDF
// fields (except the consent target, which several checkboxes may share):
//   1. known synonyms of the built-in targets (Vorname, Email, Rolle, ...)
//   2. the name equals a target's label or key
//   3. the name contains / is contained in exactly one target's label
// Fields without a confident match are left out -- the admin assigns those.

const normalize = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]/g, '');

// Patterns on the normalized PDF field name -> target. Anchored where a
// loose match would be wrong ("name" must not catch "charaktername").
const SYNONYMS = [
  [/^(vorname|firstname|rufname)$/, 'account:firstName'],
  [/^(name|nachname|familienname|lastname|surname)$/, 'account:lastName'],
  [/^(spitzname|nickname)$/, 'account:nickname'],
  [/^(e?mail|emailadresse|mailadresse|email)$/, 'sender:email'],
  [/^(charaktername|charname|figurname|name(des)?charakters)$/, 'character:name'],
  [/^(rolle|ichkommealsrolle|conrolle|teilnahmeart)$/, 'meta:conRole'],
  [/^(teilnahmegruppe|preisgruppe|ticketart)$/, 'meta:priceGroup'],
  [/^(datenschutz\d*|einverstaendnis\d*|einverstaendniserklaerung\d*|agb\d*|dsgvo\d*)$/, 'meta:waiver'],
];

const SHARED_TARGETS = new Set(['meta:waiver']);

export function suggestMapping(fields, targets) {
  const suggestions = {};
  const used = new Set();
  const claim = (fieldName, target) => {
    if (suggestions[fieldName]) return false;
    if (used.has(target) && !SHARED_TARGETS.has(target)) return false;
    suggestions[fieldName] = { target };
    used.add(target);
    return true;
  };
  const validTargets = new Set(targets.map((t) => t.value));
  const prepared = fields.map((f) => ({ field: f, norm: normalize(f.name) }));

  for (const { field, norm } of prepared) {
    const hit = SYNONYMS.find(([pattern]) => pattern.test(norm));
    if (hit && validTargets.has(hit[1])) claim(field.name, hit[1]);
  }

  const labelled = targets.map((t) => ({ target: t.value, label: normalize(t.label), key: normalize(t.value.split(':')[1]) }));
  for (const { field, norm } of prepared) {
    if (suggestions[field.name] || !norm) continue;
    const exact = labelled.filter((t) => t.label === norm || t.key === norm);
    if (exact.length === 1) claim(field.name, exact[0].target);
  }

  for (const { field, norm } of prepared) {
    if (suggestions[field.name] || norm.length < 4) continue;
    const loose = labelled.filter((t) => t.label.length >= 4
      && (norm.includes(t.label) || t.label.includes(norm))
      && !(used.has(t.target) && !SHARED_TARGETS.has(t.target)));
    if (loose.length === 1) claim(field.name, loose[0].target);
  }
  return suggestions;
}
