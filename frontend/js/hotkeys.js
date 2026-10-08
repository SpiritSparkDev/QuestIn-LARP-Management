// Hotkey spec: legacy string (key only, modifiers ignored) or { key, ctrl, alt, shift } (exact match).
const norm = (k) => (k.length === 1 ? k.toLowerCase() : k);

export function hotkeyMatches(spec, event) {
  if (!spec) return false;
  if (typeof spec === 'string') return event.key === spec;
  return norm(event.key) === norm(spec.key)
    && !!spec.ctrl === event.ctrlKey && !!spec.alt === event.altKey
    && !!spec.shift === event.shiftKey && !event.metaKey;
}

export function hotkeyFromEvent(event) {
  const spec = { key: event.key };
  if (event.ctrlKey) spec.ctrl = true;
  if (event.altKey) spec.alt = true;
  // Shift alone changes the character itself; only keep it for non-printable keys or with Ctrl/Alt.
  if (event.shiftKey && (event.key.length > 1 || event.ctrlKey || event.altKey)) spec.shift = true;
  return (spec.ctrl || spec.alt || spec.shift) ? spec : spec.key;
}

const KEY_LABEL = { Enter: 'Enter', Escape: 'Esc', ' ': 'Leertaste' };
export function hotkeyLabel(spec) {
  const key = typeof spec === 'string' ? spec : spec.key;
  const parts = [];
  if (spec.ctrl) parts.push('Strg');
  if (spec.alt) parts.push('Alt');
  if (spec.shift) parts.push('Shift');
  parts.push(KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  return parts.join('+');
}

// Combos the browser grabs before the page sees them.
const RESERVED = ['ctrl+w', 'ctrl+t', 'ctrl+n', 'ctrl+r', 'ctrl+Tab', 'ctrl+shift+w', 'ctrl+shift+t', 'ctrl+shift+n',
  'ctrl+l', 'ctrl+q', 'ctrl+f4', 'alt+f4', 'alt+ArrowLeft', 'alt+ArrowRight', 'F5', 'ctrl+F5', 'F11', 'F12'];
export function isReservedHotkey(spec) {
  if (typeof spec === 'string') spec = { key: spec };
  const id = [spec.ctrl && 'ctrl', spec.alt && 'alt', spec.shift && 'shift', norm(spec.key)].filter(Boolean).join('+');
  return RESERVED.some((r) => r.toLowerCase() === id.toLowerCase());
}

export function sameHotkey(a, b) {
  const o = (s) => (typeof s === 'string' ? { key: s } : s);
  const [x, y] = [o(a), o(b)];
  return norm(x.key) === norm(y.key) && !!x.ctrl === !!y.ctrl && !!x.alt === !!y.alt && !!x.shift === !!y.shift;
}
