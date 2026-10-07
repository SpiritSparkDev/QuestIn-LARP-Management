// Automatic pre-selection of the Teilnahmegruppe from account/registration (OT) fields.
// The admin attaches up to three rules per group (pricing.groupRules[groupName] = [rule, ...]),
// all of which must apply:
//   { source: 'account' | 'registration' | 'participation', field: <schema key>, op, value, value2? }
// 'participation' holds what the person books (SC or NSC). The registration form pre-selects
// the first group (in list order) whose rules all match what the person has entered. It is only a suggestion -- the person can
// still pick another group.

const COMPARE = [
  ['lt', 'kleiner als'],
  ['lte', 'höchstens'],
  ['eq', 'genau'],
  ['gte', 'mindestens'],
  ['gt', 'größer als'],
  ['between', 'zwischen (einschließlich)'],
];

// Which comparisons make sense for which kind of field. Date fields are compared by
// the age in full years at the event date (e.g. "Geburtsdatum → Alter mindestens 12").
const OPS_BY_TYPE = {
  number: COMPARE,
  date: COMPARE,
  text: [['eq', 'ist gleich'], ['contains', 'enthält'], ['filled', 'ist ausgefüllt']],
  textarea: [['contains', 'enthält'], ['filled', 'ist ausgefüllt']],
  link: [['contains', 'enthält'], ['filled', 'ist ausgefüllt']],
  select: [['eq', 'ist']],
  multiselect: [['has', 'enthält']],
  boolean: [['eq', 'ist']],
};

// "Teilnahme als": not an OT field but part of the booking itself.
export const PARTICIPATION_FIELDS = [{ key: 'conRole', label: 'Teilnahme als', type: 'select', options: ['SC', 'NSC'] }];
export const RULE_SOURCES = ['account', 'registration', 'participation'];
export const MAX_RULES_PER_GROUP = 3;
// The stored shape is a list; a single rule object (older data) counts as a list of one.
export const rulesOf = (stored) => (Array.isArray(stored) ? stored : stored ? [stored] : []);

export const ALL_RULE_OPS = [...new Set(Object.values(OPS_BY_TYPE).flat().map(([op]) => op))];
export const opsForType = (type) => OPS_BY_TYPE[type] ?? [];
export const supportsRules = (type) => type in OPS_BY_TYPE;
export const isNumericOp = (op) => COMPARE.some(([o]) => o === op);

// Full years between a YYYY-MM-DD birth date and a YYYY-MM-DD reference day.
export function ageAt(birthDate, atDate) {
  const born = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthDate ?? ''));
  const ref = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(atDate ?? ''));
  if (!born || !ref) return null;
  let age = Number(ref[1]) - Number(born[1]);
  if (Number(ref[2]) < Number(born[2]) || (Number(ref[2]) === Number(born[2]) && Number(ref[3]) < Number(born[3]))) age -= 1;
  return age;
}

function compare(op, n, a, b) {
  if (n == null || Number.isNaN(n)) return false;
  switch (op) {
    case 'lt': return n < a;
    case 'lte': return n <= a;
    case 'eq': return n === a;
    case 'gte': return n >= a;
    case 'gt': return n > a;
    case 'between': return n >= a && n <= b;
    default: return false;
  }
}

// Does `raw` (what the person entered for `field`) satisfy the rule?
export function ruleMatches(rule, field, raw, eventDate) {
  if (!rule || !field) return false;
  const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
  if (rule.op === 'filled') return !empty;
  if (empty && field.type !== 'boolean') return false;
  switch (field.type) {
    case 'number':
      return compare(rule.op, Number(raw), Number(rule.value), Number(rule.value2));
    case 'date':
      return compare(rule.op, ageAt(raw, eventDate), Number(rule.value), Number(rule.value2));
    case 'text':
      return rule.op === 'contains'
        ? String(raw).toLowerCase().includes(String(rule.value).toLowerCase())
        : String(raw).trim().toLowerCase() === String(rule.value).trim().toLowerCase();
    case 'textarea':
    case 'link':
      return String(raw).toLowerCase().includes(String(rule.value).toLowerCase());
    case 'select':
      return raw === rule.value;
    case 'multiselect':
      return Array.isArray(raw) && raw.includes(rule.value);
    case 'boolean':
      return Boolean(raw) === (rule.value === true || rule.value === 'true');
    default:
      return false;
  }
}

// The Teilnahmegruppe to pre-select, or null. `values` / `schemas` are keyed by rule source
// ('account', 'registration'): the entered values and the field definitions.
export function suggestPriceGroup(pricing, values, schemas, eventDate) {
  for (const group of pricing?.groups ?? []) {
    const rules = rulesOf(pricing.groupRules?.[group]);
    if (rules.length === 0) continue;
    const allMatch = rules.every((rule) => {
      const field = (schemas?.[rule.source] ?? []).find((f) => f.key === rule.field);
      return field && ruleMatches(rule, field, values?.[rule.source]?.[rule.field], eventDate);
    });
    if (allMatch) return group;
  }
  return null;
}

// Human readable summary, e.g. "Alter (Geburtsdatum) zwischen 6 und 11".
export function describeRule(rule, field) {
  if (!rule || !field) return '';
  const label = field.label ?? field.key;
  const subject = field.type === 'date' ? `Alter (${label}) in Jahren` : label;
  const op = (opsForType(field.type).find(([o]) => o === rule.op) ?? [null, rule.op])[1].replace(' (einschließlich)', '');
  if (rule.op === 'filled') return `${label} ${op}`;
  if (rule.op === 'between') return `${subject} ${op} ${rule.value} und ${rule.value2}`;
  return `${subject} ${op} ${rule.value === true ? 'Ja' : rule.value === false ? 'Nein' : rule.value}`;
}

// All rules of a group in one sentence: "Alter (Geburtsdatum) in Jahren mindestens 12 und Teilnahme als ist SC".
export function describeRules(rules, schemas) {
  return rulesOf(rules)
    .map((rule) => describeRule(rule, (schemas?.[rule.source] ?? []).find((f) => f.key === rule.field)))
    .filter(Boolean)
    .join(' und ');
}
