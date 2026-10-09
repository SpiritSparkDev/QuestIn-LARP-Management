// Right-hand, collapsible help panel: the controls of the page the person is
// on, each explained, linking into the full guide (/help.html#anchor).
// Loaded by nav.js, so every page with the sidebar gets it. The texts live in
// js/help/*.js (one entry per page); help.html renders the same data.
import account from './help/account.js';
import members from './help/members.js';
import events from './help/events.js';
import admin from './help/admin.js';

export const HELP = { ...account, ...members, ...events, ...admin };

const OPEN_KEY = 'helpPanelOpen';

function currentHint() {
  const path = window.location.pathname;
  if (path === '/account.html') return HELP[window.location.hash.slice(1)] ?? HELP.dashboard;
  return HELP[path];
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

export function itemsHtml(items) {
  return items.map((i) => `<details class="help-item"><summary>${escape(i.label)}</summary><p>${escape(i.text)}</p></details>`).join('');
}

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(panel) {
  const hint = currentHint();
  const body = panel.querySelector('.help-panel-body');
  body.innerHTML = hint
    ? `<h2>${escape(hint.title)}</h2><p>${escape(hint.intro)}</p>${itemsHtml(hint.items)}
       <a class="help-panel-link" href="/help.html#${hint.anchor}" target="_blank" rel="noopener">Diese Seite in der Anleitung</a>`
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
