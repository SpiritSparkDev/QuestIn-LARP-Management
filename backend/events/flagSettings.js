// Per special role: optional abbreviation (max 10 characters) and a predefined
// discount on the list price. Shared by the event routes (validation) and
// the registrations (pricing).

const MAX_ABBR = 10;
export const DISCOUNT_TYPES = ['percent', 'amount', 'free'];

export function validateFlagSettings(settings) {
  if (settings === undefined) return null;
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return 'flagSettings must be an object';
  for (const s of Object.values(settings)) {
    if (typeof s !== 'object' || s === null) return 'flagSettings entries must be objects';
    if (s.abbr != null && (typeof s.abbr !== 'string' || [...s.abbr.trim()].length > MAX_ABBR)) return 'Das Kürzel darf höchstens 10 Zeichen lang sein.';
    const d = s.discount;
    if (d == null) continue;
    if (!DISCOUNT_TYPES.includes(d.type)) return `discount.type must be one of: ${DISCOUNT_TYPES.join(', ')}`;
    if (d.type === 'percent' && !(Number.isInteger(d.value) && d.value >= 1 && d.value <= 100)) return 'Der Prozent-Rabatt muss eine ganze Zahl von 1 bis 100 sein.';
    if (d.type === 'amount' && !(Number.isInteger(d.value) && d.value >= 1)) return 'Der Rabatt-Betrag muss größer als 0 sein.';
  }
  return null;
}

// Only for flags that exist; drops empty entries.
export function normalizeFlagSettings(settings, flags) {
  const result = {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return result;
  for (const name of flags) {
    const s = settings[name];
    if (!s || typeof s !== 'object') continue;
    const entry = {};
    const abbr = typeof s.abbr === 'string' ? [...s.abbr.trim()].slice(0, MAX_ABBR).join('') : '';
    if (abbr) entry.abbr = abbr;
    if (DISCOUNT_TYPES.includes(s.discount?.type)) {
      entry.discount = s.discount.type === 'free' ? { type: 'free' } : { type: s.discount.type, value: s.discount.value };
    }
    if (Object.keys(entry).length) result[name] = entry;
  }
  return result;
}

// Cents taken off the list price by the registration's flags. Several
// discounted roles don't stack: the best single discount counts.
export function flagDiscountCents(flagSettings, flags, listCents) {
  if (listCents == null || listCents <= 0) return 0;
  let best = 0;
  for (const name of flags ?? []) {
    const d = flagSettings?.[name]?.discount;
    if (!d) continue;
    const cents = d.type === 'free' ? listCents : d.type === 'percent' ? Math.round((listCents * d.value) / 100) : d.value;
    best = Math.max(best, Math.min(cents, listCents));
  }
  return best;
}
