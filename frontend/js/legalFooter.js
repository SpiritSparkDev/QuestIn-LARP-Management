// Datenschutz-/Impressum-Links: wird von nav.js (eingeloggte Seiten) und den
// oeffentlichen Seiten eingebunden. Ziele kommen aus GET /legal-documents.
// Datenschutz ist immer verlinkt (statische Seite als Fallback), Impressum nur
// wenn konfiguriert.
export async function fetchLegalDocuments() {
  try {
    const res = await fetch('/legal-documents');
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function target(doc, page) {
  return doc?.mode === 'url' ? doc.url : page;
}

async function renderLegalFooter() {
  const docs = await fetchLegalDocuments();
  const items = [['Datenschutz', target(docs?.privacy, '/datenschutz.html')]];
  if (docs?.imprint?.mode) items.push(['Impressum', target(docs.imprint, '/impressum.html')]);
  const footer = document.createElement('p');
  footer.className = 'legal-footer';
  footer.style.cssText = 'text-align:center;font-size:.8rem;margin:16px 0;display:flex;gap:16px;justify-content:center';
  for (const [label, href] of items) {
    const a = document.createElement('a');
    a.href = href; // assigned via DOM, never concatenated into HTML
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    footer.appendChild(a);
  }
  const sidebarFoot = document.querySelector('.sidebar-foot');
  if (sidebarFoot) {
    footer.style.margin = '8px 0 0';
    sidebarFoot.appendChild(footer);
  } else {
    document.body.appendChild(footer);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderLegalFooter);
else renderLegalFooter();
