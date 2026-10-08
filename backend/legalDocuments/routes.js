import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { sanitizeRichText } from '../richText.js';
import { getLegalDocuments, setLegalDocuments } from './repository.js';

const MAX_HTML = 200000;

// Returns { value } or { error }. mode '' / 'none' / null = not configured.
function parseDocument(input, label) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { error: `${label} must be an object` };
  const { mode } = input;
  if (mode === undefined || mode === null || mode === '' || mode === 'none') return { value: { mode: null, url: null, html: null } };
  if (mode === 'url') {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* invalid */ }
    if (!ok) return { error: `${label}: url must be a valid http:// or https:// address` };
    return { value: { mode, url, html: null } };
  }
  if (mode === 'text') {
    if (typeof input.html !== 'string' || input.html.length > MAX_HTML) return { error: `${label}: html must be a string of at most ${MAX_HTML} characters` };
    const html = sanitizeRichText(input.html);
    if (html.replace(/<[^>]*>/g, '').trim() === '') return { value: { mode: null, url: null, html: null } };
    return { value: { mode, url: null, html } };
  }
  return { error: `${label}: mode must be one of: url, text, none` };
}

// Public: the login/register pages and footers need it without a session.
router.get('/legal-documents', async () => ({ status: 200, body: await getLegalDocuments() }));

router.put('/legal-documents', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const docs = {};
  for (const kind of ['privacy', 'imprint']) {
    if (body[kind] === undefined) continue;
    const parsed = parseDocument(body[kind], kind);
    if (parsed.error) return { status: 400, body: { error: parsed.error } };
    docs[kind] = parsed.value;
  }
  return { status: 200, body: await setLegalDocuments(docs) };
})));
