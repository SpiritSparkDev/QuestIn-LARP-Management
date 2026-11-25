// Maps a character from the QuestIn hub's Charakter-Mappe onto this
// instance's SC character schema. The schema is org-specific, so fields are
// matched by their label; whatever does not fit is left for the person to fill
// in. Labels are matched as parts of words (German compounds such as
// "Hintergrundgeschichte"). The result only prefills the form, nothing is saved here.

const MATCHERS = {
  people: /(volk|rasse|spezies|herkunft|abstammung)/i,
  profession: /(klasse|beruf|profession|tätigkeit|taetigkeit)/i,
  summary: /(kurzbeschreibung|beschreibung|kurzinfo|steckbrief)/i,
  background: /(hintergrund|geschichte|background|biografie|biographie)/i,
};
const MAX_VALUE_LENGTH = 5000;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toDocument = (text) => text.split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

function valueFor(field, text) {
  if (field.type === 'text') return text.replace(/\s*\n\s*/g, ' ').slice(0, MAX_VALUE_LENGTH);
  if (field.type === 'textarea') return text.slice(0, MAX_VALUE_LENGTH);
  if (field.type === 'document') return toDocument(text);
  if (field.type === 'select' && Array.isArray(field.options)) {
    return field.options.find((o) => String(o).toLowerCase() === text.trim().toLowerCase());
  }
  return undefined;
}

// Returns { name, data, unmatched: [hub keys without a field] }.
export function mapHubCharacter(character, schema) {
  const data = {};
  const used = new Set();
  const unmatched = [];
  for (const key of ['people', 'profession', 'summary', 'background']) {
    const text = typeof character[key] === 'string' ? character[key].trim() : '';
    if (!text) continue;
    const field = (schema ?? []).find((f) => !used.has(f.key) && !f.staffOnly && MATCHERS[key].test(String(f.label ?? ''))
      && valueFor(f, text) !== undefined);
    if (!field) {
      unmatched.push(key);
      continue;
    }
    used.add(field.key);
    data[field.key] = valueFor(field, text);
  }
  return { name: String(character.name ?? '').trim().slice(0, 200), data, unmatched };
}
