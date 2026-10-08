// Hotkey format per action: a plain key string (legacy, modifiers ignored when matching)
// or { key, ctrl?, alt?, shift? } (modifiers compared exactly).
const ACTIONS = ['confirm', 'cancel', 'scan'];
const MODIFIERS = ['ctrl', 'alt', 'shift'];

function validSpec(spec) {
  if (typeof spec === 'string') return spec.length > 0 && spec.length <= 32;
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return false;
  if (typeof spec.key !== 'string' || spec.key.length === 0 || spec.key.length > 32) return false;
  return Object.entries(spec).every(([k, v]) => k === 'key' || (MODIFIERS.includes(k) && typeof v === 'boolean'));
}

// Returns an error string, or null when valid. null/undefined means "not sent".
export function hotkeysError(hotkeys) {
  if (hotkeys === undefined || hotkeys === null) return null;
  if (typeof hotkeys !== 'object' || Array.isArray(hotkeys)) return 'hotkeys must be an object';
  for (const [action, spec] of Object.entries(hotkeys)) {
    if (!ACTIONS.includes(action)) return `unknown hotkey action: ${action}`;
    if (!validSpec(spec)) return `invalid hotkey for ${action}`;
  }
  return null;
}
