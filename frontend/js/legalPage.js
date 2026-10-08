// /datenschutz.html und /impressum.html: ist ein eigenes Dokument konfiguriert,
// wird auf dessen URL weitergeleitet bzw. der (serverseitig sanitisierte) Text
// angezeigt. Sonst bleibt der statische Inhalt der Seite stehen.
import { fetchLegalDocuments } from './legalFooter.js';

export async function applyLegalDocument(kind, title) {
  const doc = (await fetchLegalDocuments())?.[kind];
  if (doc?.mode === 'url') {
    window.location.replace(doc.url);
  } else if (doc?.mode === 'text') {
    const box = document.getElementById('legal-content');
    box.innerHTML = '';
    const h1 = document.createElement('h1');
    h1.textContent = title;
    const body = document.createElement('div');
    body.innerHTML = doc.html; // sanitized on save by backend/richText.js
    box.append(h1, body);
  } else if (kind === 'imprint') {
    document.getElementById('legal-content').innerHTML = '<h1>Impressum</h1><p>Es ist kein Impressum hinterlegt.</p>';
  }
}
