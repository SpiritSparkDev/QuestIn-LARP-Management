// Allowlist sanitizer for "document" (WYSIWYG) field values. The browser
// editor produces HTML; anything stored is re-written here so only a small,
// attribute-free set of tags survives (plus http/https/mailto links), no
// matter what a client actually sent. The frontend sanitizes again on
// render (frontend/js/richText.js) -- keep both allowlists in sync.

const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h3', 'h4', 'blockquote', 'a']);
const TAG_ALIASES = { div: 'p', h1: 'h3', h2: 'h3', h5: 'h4', h6: 'h4', strike: 's', del: 's' };
const VOID_TAGS = new Set(['br']);
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi;
const TOKEN = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function escapeText(text) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractHref(attributes) {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  return SAFE_HREF.test(raw) ? raw : null;
}

export function sanitizeRichText(input) {
  if (typeof input !== 'string') return '';
  const source = input.replace(DROP_WITH_CONTENT, '');
  const open = [];
  let out = '';
  let lastIndex = 0;
  for (const match of source.matchAll(TOKEN)) {
    out += escapeText(source.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    if (!match[1]) continue; // comment
    const rawName = match[1].toLowerCase();
    const name = TAG_ALIASES[rawName] ?? rawName;
    if (!ALLOWED_TAGS.has(name)) continue;
    const isClosing = match[0].startsWith('</');
    if (VOID_TAGS.has(name)) {
      if (!isClosing) out += `<${name}>`;
      continue;
    }
    if (isClosing) {
      const index = open.lastIndexOf(name);
      if (index === -1) continue;
      while (open.length > index) out += `</${open.pop()}>`;
      continue;
    }
    if (name === 'a') {
      const href = extractHref(match[2]);
      if (href === null) continue;
      out += `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">`;
    } else {
      out += `<${name}>`;
    }
    open.push(name);
  }
  out += escapeText(source.slice(lastIndex));
  while (open.length > 0) out += `</${open.pop()}>`;
  return out;
}

export function richTextToPlain(html) {
  return String(html ?? '')
    .replace(/<\/(p|li|h3|h4|blockquote)>|<br>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// Sanitizes a document-type field's string value; an editor that only holds
// empty paragraphs/line breaks collapses to '' so "required" works.
export function sanitizeDocumentValue(value) {
  if (typeof value !== 'string') return value;
  const clean = sanitizeRichText(value);
  return richTextToPlain(clean).trim() === '' ? '' : clean;
}

// Returns a copy of `data` with every document-type value sanitized.
export function sanitizeDocumentFields(schema, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const result = { ...data };
  for (const field of schema) {
    if (field.type === 'document' && Object.hasOwn(result, field.key)) {
      result[field.key] = sanitizeDocumentValue(result[field.key]);
    }
  }
  return result;
}

// For the OT (account/registration) write paths that copy one schema field
// at a time: sanitizes only document-type fields, passes everything else on.
export function sanitizeFieldValue(field, value) {
  return field.type === 'document' ? sanitizeDocumentValue(value) : value;
}
