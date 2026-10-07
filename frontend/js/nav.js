import { escapeHtml } from './formFields.js';
import { APP_VERSION } from './version.js';
import { initResponsiveTables } from './responsiveTables.js';
import { api } from './api.js';

// Every page that renders the sidebar also gets the narrow-screen table
// labelling -- nav.js is the one module they all share.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initResponsiveTables);
} else {
  initResponsiveTables();
}

// Dashboard/Konto/Anmelden/Charaktere are facets of the same 'konto'
// permission and the same page (account.html) -- distinguished only by
// hash, so they render identically (and consistently, on every page,
// admin pages included) to every other role-gated nav item. account.html
// itself reads location.hash to decide which of the panels shows.
const MENU_LINKS = [
  { key: 'konto', label: 'Dashboard', href: '/account.html#dashboard', icon: 'dashboard' },
  { key: 'konto', label: 'Konto', href: '/account.html#konto', icon: 'manage_accounts' },
  { key: 'konto', label: 'Anmelden', href: '/account.html#anmelden', icon: 'event' },
  { key: 'konto', label: 'Gruppe', href: '/account.html#gruppe', icon: 'groups_2', groupMenu: true },
  { key: 'konto', label: 'Charaktere', href: '/account.html#charaktere', icon: 'theater_comedy' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html', icon: 'group' },
  { key: 'events', label: 'Events', href: '/admin/events.html', icon: 'calendar_month' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html', icon: 'qr_code_scanner' },
  { key: 'taverne', flag: 'tavernEnabled', label: 'Taverne', href: '/admin/tavern.html', icon: 'local_bar' },
];

const ADMIN_ONLY_LINKS = [
  { label: 'Rollen', href: '/admin/groups.html', icon: 'groups' },
  { label: 'Charakterschema', href: '/admin/character-schema.html', icon: 'badge' },
  { label: 'E-Mail-Vorlagen', href: '/admin/email-templates.html', icon: 'mail' },
  { label: 'Einstellungen', href: '/admin/settings.html', icon: 'settings' },
  { label: 'Protokoll', href: '/admin/audit.html', icon: 'history' },
];

// Opt-in add-ons (switched on under Einstellungen); `flag` is the /account
// property that says whether the add-on is enabled.
const ADDON_LINKS = [
  { flag: 'pdfImportEnabled', label: 'PDF-Import', href: '/admin/pdf-import.html', icon: 'picture_as_pdf' },
  { flag: 'pdfExportEnabled', label: 'PDF-Erzeugung', href: '/admin/pdf-export.html', icon: 'description' },
  { flag: 'lodgingEnabled', label: 'Unterkünfte', href: '/admin/lodging.html', icon: 'bed' },
];

function renderNavItem({ href, label, icon, dot }, currentPath) {
  const current = href === currentPath ? 'sidebar-nav-item current' : 'sidebar-nav-item';
  const dotHtml = dot ? '<span class="nav-dot" role="img" aria-label="Angaben unvollständig" title="Angaben unvollständig"></span>' : '';
  return `<a href="${href}" class="${current}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span>${dotHtml}</a>`;
}

// Thin warning strip on every page while the fictional test data is loaded,
// so nobody mistakes it for real registrations. renderNavLinks runs on every
// page that has the sidebar, so it is the one place that sees the account.
function showTestModeBanner(account) {
  const existing = document.getElementById('testmode-banner');
  // "Als [Rolle] betrachten" (admins) takes the strip over while it is active.
  const viewing = account.viewingAs;
  document.body?.classList.toggle('has-testmode-banner', Boolean(account.testMode || viewing));
  if (!account.testMode && !viewing) {
    existing?.remove();
    return;
  }
  if (!document.body) return;
  const banner = existing ?? document.createElement('div');
  banner.id = 'testmode-banner';
  banner.className = 'testmode-banner';
  if (viewing) {
    banner.innerHTML = `Du betrachtest das Tool als „${escapeHtml(viewing.name)}“ <button type="button" class="btn-sm" id="view-as-stop">Ansicht beenden</button>`;
    banner.querySelector('#view-as-stop').addEventListener('click', async () => {
      await api.post('/view-as', { groupId: null });
      window.location.reload();
    });
  } else {
    banner.textContent = 'Test-Modus aktiv – alle Personen und das Event sind fiktiv';
  }
  if (!existing) document.body.prepend(banner);
}

const ADMIN_OPEN_KEY = 'sidebarAdminOpen';
const GROUP_MENU_KEY = 'groupMenuEnabled';

export function groupMenuEnabled() {
  try {
    return localStorage.getItem(GROUP_MENU_KEY) === '1';
  } catch {
    return false;
  }
}

// Per-browser switch for the "Gruppe" menu entry. Returns true if it changed.
export function setGroupMenuEnabled(on) {
  if (groupMenuEnabled() === on) return false;
  try {
    localStorage.setItem(GROUP_MENU_KEY, on ? '1' : '0');
  } catch {
    return false;
  }
  return true;
}

function readAdminSectionOpen() {
  try {
    return localStorage.getItem(ADMIN_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

// Only a click on the summary counts as the person's choice -- the `toggle`
// event also fires when the section is rendered open because the current
// page lives inside it, and that must not be remembered. Delegated, so it
// keeps working however often the nav HTML is re-rendered.
document.addEventListener('click', (event) => {
  const summary = event.target.closest?.('.sidebar-admin > summary');
  if (!summary) return;
  const details = summary.parentElement;
  // The browser flips `open` after this handler runs.
  setTimeout(() => {
    // Opening it near the bottom of a long nav: bring the new entries into view.
    if (details.open) details.lastElementChild?.scrollIntoView({ block: 'nearest' });
    try {
      localStorage.setItem(ADMIN_OPEN_KEY, details.open ? '1' : '0');
    } catch {
      // Storage unavailable (private mode) -- the choice just isn't remembered.
    }
  }, 0);
});

export function renderNavLinks(account, currentPath, { accountIncomplete = false } = {}) {
  showTestModeBanner(account);
  // Add-on entries (item.flag) also need the add-on switched on; admins see
  // every enabled add-on without needing its menu key.
  const items = MENU_LINKS.filter((item) => (account.menus.includes(item.key) || (item.flag && account.group.key === 'admin')) && (!item.flag || account[item.flag]) && (!item.groupMenu || (groupMenuEnabled() || account.groupMemberOnly)));
  let html = items.map((item) => renderNavItem(item.label === 'Konto' ? { ...item, dot: accountIncomplete } : item, currentPath)).join('');
  
  // Admin-only entries and enabled add-ons live in a collapsible
  // "Administration" section so the sidebar stays short. It is forced open
  // while one of its pages is current (so the highlighted entry is visible);
  // otherwise the person's last choice is remembered.
  if (account.group.key === 'admin') {
    const adminItems = [...ADMIN_ONLY_LINKS, ...ADDON_LINKS.filter((item) => account[item.flag])];
    const containsCurrent = adminItems.some((item) => item.href === currentPath);
    const open = containsCurrent || readAdminSectionOpen();
    html += `<details class="sidebar-admin"${open ? ' open' : ''}>
      <summary><span class="material-symbols-outlined" aria-hidden="true">admin_panel_settings</span><span>Administration</span><span class="material-symbols-outlined sidebar-admin-chevron" aria-hidden="true">expand_more</span></summary>
      ${adminItems.map((item) => renderNavItem(item, currentPath)).join('')}
    </details>`;
  }
  return html;
}

// Renders the sidebar's bottom user-identity block (avatar initials, display
// name, group/role name) -- NOT the logout control, which stays a static,
// already-wired element in each page's own markup so this can be re-rendered
// (e.g. on account.html, alongside the tab-driven nav) without ever
// re-creating -- and so losing the listener on -- the logout button.
export function renderSidebarUser(account) {
  const initials = `${account.firstName?.[0] ?? ''}${account.lastName?.[0] ?? ''}`.toUpperCase();
  return `<div class="sidebar-user">
    <div class="sidebar-user-avatar">${escapeHtml(initials)}</div>
    <div class="sidebar-user-text">
      <p class="sidebar-user-name">${escapeHtml(account.name)}</p>
      <p class="sidebar-user-role">${escapeHtml(account.group.name)}</p>
    </div>
  </div>
  <p class="sidebar-version">v${APP_VERSION}</p>`;
}

// Wires the mobile hamburger button (#sidebar-toggle) to show/hide #sidebar
// as an overlay, and closes it on an outside click. No-ops if either element
// is missing (keeps this safe to call unconditionally on every page).
export function initSidebarToggle() {
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (!toggle || !sidebar) return;
  toggle.addEventListener('click', () => sidebar.classList.toggle('sidebar--open'));
  document.addEventListener('click', (event) => {
    if (!sidebar.classList.contains('sidebar--open')) return;
    if (sidebar.contains(event.target) || toggle.contains(event.target)) return;
    sidebar.classList.remove('sidebar--open');
  });
}

// ---- Stand-alone mode -------------------------------------------------
// /checkin and /taverne open the same pages as the admin menu entries, but
// without the sidebar: a slim top bar instead, so a tablet or phone can sit
// on one task (check-in desk, bar) with the whole screen. Access rules are
// unchanged -- it is only a different frame around the same page.
const STANDALONE_TITLES = { '/checkin': 'Check-In', '/taverne': 'Taverne' };

function initStandaloneMode() {
  const title = STANDALONE_TITLES[window.location.pathname];
  if (!title) return;
  document.body.classList.add('standalone');
  const bar = document.createElement('header');
  bar.className = 'standalone-bar';
  bar.innerHTML = `<a href="/account.html#dashboard" class="standalone-home"><span class="material-symbols-outlined" aria-hidden="true">arrow_back</span><span>Zur App</span></a>
    <strong>${escapeHtml(title)}</strong>
    <a href="#" class="standalone-logout">Logout</a>`;
  // The page wires logout to the sidebar's (now hidden) link; reuse it.
  bar.querySelector('.standalone-logout').addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById('logout-link')?.click();
  });
  document.body.prepend(bar);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStandaloneMode);
} else {
  initStandaloneMode();
}
