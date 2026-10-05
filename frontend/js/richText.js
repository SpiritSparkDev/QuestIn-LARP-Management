// "Dokument" field type: a small WYSIWYG editor (contenteditable + toolbar)
// without any external library. The editor HTML is mirrored into a hidden
// input so the existing form collectors (FormData / [data-field]) keep
// working unchanged. Allowlist is kept in sync with backend/richText.js.

const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'UL', 'OL', 'LI', 'H3', 'H4', 'BLOCKQUOTE', 'A']);
const TAG_ALIASES = { DIV: 'P', H1: 'H3', H2: 'H3', H5: 'H4', H6: 'H4', STRIKE: 'S', DEL: 'S' };
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

// Pure string helper (also used from node unit tests): readable plain text
// for tables/exports where HTML would show up as raw tags.
export function htmlToPlainText(html) {
  return String(html ?? '')
    .replace(/<\/(p|li|h3|h4|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanNode(node, doc) {
  const fragment = doc.createDocumentFragment();
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      fragment.appendChild(doc.createTextNode(child.nodeValue));
    } else if (child.nodeType === 1) {
      const name = TAG_ALIASES[child.tagName] ?? child.tagName;
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
      if (!ALLOWED_TAGS.has(name)) {
        fragment.appendChild(cleanNode(child, doc));
      } else if (name === 'BR') {
        fragment.appendChild(doc.createElement('br'));
      } else if (name === 'A') {
        const href = (child.getAttribute('href') ?? '').trim();
        if (!SAFE_HREF.test(href)) {
          fragment.appendChild(cleanNode(child, doc));
        } else {
          const a = doc.createElement('a');
          a.setAttribute('href', href);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.appendChild(cleanNode(child, doc));
          fragment.appendChild(a);
        }
      } else {
        const el = doc.createElement(name.toLowerCase());
        el.appendChild(cleanNode(child, doc));
        fragment.appendChild(el);
      }
    }
  }
  return fragment;
}

// Browser-only: parses into an inert document, rebuilds from the allowlist.
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html ?? ''}</body>`, 'text/html');
  const holder = doc.createElement('div');
  holder.appendChild(cleanNode(doc.body, doc));
  return holder.innerHTML;
}

// Waiver text: admins may type HTML (rendered through the allowlist above);
// older plain-text waivers keep their line breaks.
export function renderRichText(text) {
  const source = String(text ?? '');
  if (/<[a-z][\s\S]*>/i.test(source)) return sanitizeHtml(source);
  return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

const TOOLBAR = [
  { command: 'bold', icon: 'format_bold', label: 'Fett' },
  { command: 'italic', icon: 'format_italic', label: 'Kursiv' },
  { command: 'underline', icon: 'format_underlined', label: 'Unterstrichen' },
  { command: 'heading', icon: 'title', label: 'Überschrift' },
  { command: 'insertUnorderedList', icon: 'format_list_bulleted', label: 'Aufzählung' },
  { command: 'insertOrderedList', icon: 'format_list_numbered', label: 'Nummerierte Liste' },
  { command: 'quote', icon: 'format_quote', label: 'Zitat' },
  { command: 'link', icon: 'link', label: 'Link einfügen' },
  { command: 'removeFormat', icon: 'format_clear', label: 'Formatierung entfernen' },
];

export function renderToolbar() {
  return `<div class="rte-toolbar" role="toolbar" aria-label="Textformatierung">${TOOLBAR.map((b) => `<button type="button" class="rte-btn" data-rte-command="${b.command}" title="${b.label}" aria-label="${b.label}"><span class="material-symbols-outlined" aria-hidden="true">${b.icon}</span></button>`).join('')}</div>`;
}

function syncHidden(rte) {
  const editor = rte.querySelector('.rte-editor');
  const hidden = rte.querySelector('input[type="hidden"]');
  const clean = sanitizeHtml(editor.innerHTML);
  hidden.value = htmlToPlainText(clean) === '' ? '' : clean;
  hidden.dispatchEvent(new Event('input', { bubbles: true }));
}

function runCommand(rte, command) {
  const editor = rte.querySelector('.rte-editor');
  editor.focus();
  document.execCommand('defaultParagraphSeparator', false, 'p');
  if (command === 'heading') {
    const current = document.queryCommandValue('formatBlock').toLowerCase();
    document.execCommand('formatBlock', false, current === 'h3' ? 'p' : 'h3');
  } else if (command === 'quote') {
    const current = document.queryCommandValue('formatBlock').toLowerCase();
    document.execCommand('formatBlock', false, current === 'blockquote' ? 'p' : 'blockquote');
  } else if (command === 'link') {
    const url = window.prompt('Link-Adresse (https://…)');
    if (url && SAFE_HREF.test(url.trim())) document.execCommand('createLink', false, url.trim());
  } else {
    document.execCommand(command, false, null);
  }
  syncHidden(rte);
}

if (typeof document !== 'undefined') {
  // Delegated, so editors rendered later (innerHTML) need no init call.
  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('.rte-btn')) event.preventDefault(); // keep the editor's selection
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.rte-btn');
    if (!button) return;
    const rte = button.closest('.rte');
    if (rte) runCommand(rte, button.dataset.rteCommand);
  });
  document.addEventListener('input', (event) => {
    if (!event.target.classList?.contains('rte-editor')) return;
    syncHidden(event.target.closest('.rte'));
  });
  document.addEventListener('paste', (event) => {
    if (!event.target.classList?.contains('rte-editor')) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
  });
}
