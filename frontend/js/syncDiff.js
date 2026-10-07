// Flattens a conflict value ({kind, ...}) into "a.b[0].c" -> text pairs so the
// Datenabgleich page can show offline and online side by side and mark the
// fields that differ.
export function flatten(value, prefix = '', out = {}) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [`[${i}]`, v]) : Object.entries(value);
    if (entries.length === 0) out[prefix] = Array.isArray(value) ? '[]' : '{}';
    for (const [k, v] of entries) flatten(v, prefix ? (k.startsWith('[') ? prefix + k : `${prefix}.${k}`) : k, out);
  } else {
    out[prefix] = value === null || value === undefined ? '–' : String(value);
  }
  return out;
}

// Keys (union, offline order first) with whether the two sides differ.
export function sideBySide(offline, online) {
  const a = flatten(offline ?? {});
  const b = flatten(online ?? {});
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.map((key) => ({ key, offline: a[key] ?? '–', online: b[key] ?? '–', differs: a[key] !== b[key] }));
}
