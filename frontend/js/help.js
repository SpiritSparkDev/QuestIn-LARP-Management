// Right-hand, collapsible help panel: a few short hints for the page the
// person is on, each linking into the full guide (/help.html#anchor).
// Loaded by nav.js, so every page with the sidebar gets it. To document a
// page, add an entry below and a matching <section id="..."> in help.html.
const HINTS = {
  dashboard: { title: 'Dashboard', anchor: 'dashboard', tips: [
    'Hier siehst du auf einen Blick, was noch zu tun ist: Angaben, Anmeldung, Zahlung.',
    'Offene Aufgaben (z. B. Änderungen an deinem Charakter bestätigen) erscheinen als Karten.',
  ] },
  konto: { title: 'Konto', anchor: 'konto', tips: [
    'Trage deine Stammdaten ein. Der rote Punkt im Menü zeigt, dass Pflichtangaben fehlen.',
    'E-Mail und Passwort änderst du ebenfalls hier.',
  ] },
  anmelden: { title: 'Anmelden', anchor: 'anmelden', tips: [
    'Wähle ein Event, deine Optionen (Unterkunft, Extras) und schicke die Anmeldung ab.',
    'Der Preis wird live berechnet. Bei vollem Event landest du auf der Warteliste.',
  ] },
  gruppe: { title: 'Gruppe', anchor: 'gruppe', tips: [
    'Melde Personen deiner Gruppe über ihre Karte an – oder alle auf einmal.',
    'Weitere Verwalter lädst du über einen Einladungslink ein.',
  ] },
  charaktere: { title: 'Charaktere', anchor: 'charaktere', tips: [
    'Lege SC (Spielercharaktere) und NSC an und pflege ihre Merkmale.',
    'Änderungen an fremden Charakteren muss der Besitzer erst bestätigen.',
  ] },
  '/admin/members.html': { title: 'Mitglieder', anchor: 'mitglieder', tips: [
    'Suche, filtere und öffne Personen; hier verwaltest du auch Rollen und Zahlungen.',
  ] },
  '/admin/events.html': { title: 'Events', anchor: 'events', tips: [
    'Event anlegen, Preise, Teilnehmerlimit, Fristen und Anmeldeoptionen festlegen.',
    'Das Teilnehmerlimit hat eine Hartgrenze; „Letzte Plätze“ wird automatisch angezeigt.',
  ] },
  '/admin/checkin.html': { title: 'Check-In', anchor: 'checkin', tips: [
    'Ticket-QR scannen oder Namen suchen. Unter /checkin läuft die Seite ohne Menü (Tablet).',
  ] },
  '/admin/tavern.html': { title: 'Taverne', anchor: 'taverne', tips: [
    'Buchungen an der Theke erfassen. Unter /taverne läuft die Seite ohne Menü.',
  ] },
  '/admin/groups.html': { title: 'Rollen', anchor: 'rollen', tips: [
    'Lege Rollen an und bestimme, welche Menüs und Rechte sie haben.',
  ] },
  '/admin/character-schema.html': { title: 'Charakterschema', anchor: 'schema', tips: [
    'Definiere die Felder für Konto, Anmeldung und Charaktere.',
    'Mit „Gruppenverwaltung“ geben Gruppenleitungen ein Feld für ihre Mitglieder frei.',
  ] },
  '/admin/email-templates.html': { title: 'E-Mail-Vorlagen', anchor: 'email', tips: [
    'Texte der automatischen Mails bearbeiten. Platzhalter wie {{name}} werden beim Versand ersetzt.',
  ] },
  '/admin/sync.html': { title: 'Datenabgleich', anchor: 'sync', tips: [
    'Gleicht die Online-Daten mit der Offline-Con-Instanz ab. Siehe Betrieb Offline.',
  ] },
  '/admin/settings.html': { title: 'Einstellungen', anchor: 'einstellungen', tips: [
    'Hier schaltest du Zusatzmodule (PDF, Unterkünfte, Taverne) ein und stellst Branding und Speicher ein.',
  ] },
  '/admin/audit.html': { title: 'Protokoll', anchor: 'protokoll', tips: [
    'Zeigt, wer wann was geändert hat.',
  ] },
  '/admin/pdf-import.html': { title: 'PDF-Import', anchor: 'pdf', tips: ['Lädt Charakterbögen aus PDFs in die Datenbank.'] },
  '/admin/pdf-export.html': { title: 'PDF-Erzeugung', anchor: 'pdf', tips: ['Erzeugt Charakterbögen und Listen als PDF.'] },
  '/admin/lodging.html': { title: 'Unterkünfte', anchor: 'unterkuenfte', tips: ['Verwalte Schlafplätze und weise sie Teilnehmern zu.'] },
};

const OPEN_KEY = 'helpPanelOpen';

function currentHint() {
  const path = window.location.pathname;
  if (path === '/account.html') return HINTS[window.location.hash.slice(1)] ?? HINTS.dashboard;
  return HINTS[path];
}

function isOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function setOpen(panel, open) {
  panel.classList.toggle('help-panel--open', open);
  document.body.classList.toggle('help-open', open);
  panel.querySelector('.help-panel-tab').setAttribute('aria-expanded', String(open));
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // Storage unavailable -- the choice just isn't remembered.
  }
}

function render(panel) {
  const hint = currentHint();
  const body = panel.querySelector('.help-panel-body');
  // Static strings above, no user data -- innerHTML is safe here.
  body.innerHTML = hint
    ? `<h2>${hint.title}</h2><ul>${hint.tips.map((t) => `<li>${t.replace(/</g, '&lt;')}</li>`).join('')}</ul>
       <a class="help-panel-link" href="/help.html#${hint.anchor}" target="_blank" rel="noopener">Ausführliche Hilfe zu „${hint.title}“</a>`
    : '';
  body.insertAdjacentHTML('beforeend', '<a class="help-panel-link" href="/help.html" target="_blank" rel="noopener">Gesamte Anleitung</a>');
}

function initHelpPanel() {
  // /checkin and /taverne are the menu-less stand-alone frames.
  if (!document.getElementById('sidebar') || ['/checkin', '/taverne'].includes(window.location.pathname)) return;
  const panel = document.createElement('aside');
  panel.className = 'help-panel';
  panel.id = 'help-panel';
  panel.setAttribute('aria-label', 'Hilfe');
  panel.innerHTML = `<button type="button" class="help-panel-tab" aria-controls="help-panel-body" aria-expanded="false" title="Hilfe ein-/ausblenden">
      <span class="material-symbols-outlined" aria-hidden="true">help</span><span class="help-panel-tab-label">Hilfe</span></button>
    <div class="help-panel-body" id="help-panel-body"></div>`;
  document.body.append(panel);
  render(panel);
  setOpen(panel, isOpen());
  panel.querySelector('.help-panel-tab').addEventListener('click', () => setOpen(panel, !panel.classList.contains('help-panel--open')));
  window.addEventListener('hashchange', () => render(panel));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHelpPanel);
} else {
  initHelpPanel();
}
