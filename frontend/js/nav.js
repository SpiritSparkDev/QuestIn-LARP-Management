import { escapeHtml } from './formFields.js';
import { APP_VERSION } from './version.js';
import { initResponsiveTables } from './responsiveTables.js';

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
  { key: 'konto', label: 'Charaktere', href: '/account.html#charaktere', icon: 'theater_comedy' },
  { key: 'dateien', label: 'Dateien', href: '/account.html#dateien', icon: 'folder' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html', icon: 'group' },
  { key: 'events', label: 'Events', href: '/admin/events.html', icon: 'calendar_month' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html', icon: 'qr_code_scanner' },
  { key: 'taverne', flag: 'tavernEnabled', label: 'Taverne', href: '/admin/tavern.html', icon: 'local_bar' },
];

const ADMIN_ONLY_LINKS = [
  { label: 'Gruppen', href: '/admin/groups.html', icon: 'groups' },
  { label: 'Charakterschema', href: '/admin/character-schema.html', icon: 'badge' },
  { label: 'E-Mail-Vorlagen', href: '/admin/email-templates.html', icon: 'mail' },
  { label: 'Einstellungen', href: '/admin/settings.html', icon: 'settings' },
  { label: 'Branding', href: '/admin/branding.html', icon: 'palette' },
  { label: 'Speicher', href: '/admin/storage.html', icon: 'storage' },
];

// Opt-in add-ons (switched on under Einstellungen); `flag` is the /account
// property that says whether the add-on is enabled.
const ADDON_LINKS = [
  { flag: 'pdfImportEnabled', label: 'PDF-Import', href: '/admin/pdf-import.html', icon: 'picture_as_pdf' },
];

function renderNavItem({ href, label, icon }, currentPath) {
  const current = href === currentPath ? 'sidebar-nav-item current' : 'sidebar-nav-item';
  return `<a href="${href}" class="${current}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></a>`;
}

// Thin warning strip on every page while the fictional test data is loaded,
// so nobody mistakes it for real registrations. renderNavLinks runs on every
// page that has the sidebar, so it is the one place that sees the account.
function showTestModeBanner(account) {
  const existing = document.getElementById('testmode-banner');
  if (!account.testMode) {
    existing?.remove();
    return;
  }
  if (existing || !document.body) return;
  const banner = document.createElement('div');
  banner.id = 'testmode-banner';
  banner.className = 'testmode-banner';
  banner.textContent = 'Test-Modus aktiv – alle Personen und das Event sind fiktiv';
  document.body.prepend(banner);
}

export function renderNavLinks(account, currentPath) {
  showTestModeBanner(account);
  // Add-on entries (item.flag) also need the add-on switched on; admins see
  // every enabled add-on without needing its menu key.
  const items = MENU_LINKS.filter((item) => (account.menus.includes(item.key) || (item.flag && account.group.key === 'admin')) && (!item.flag || account[item.flag]));
  let html = items.map((item) => renderNavItem(item, currentPath)).join('');
  
  // A visual divider before the admin-only section -- keeps the role-gated
  // items (everything above) and the admin-only items (everything below)
  // visibly distinct, since both render through this same, single,
  // role-driven function rather than any page-specific special-casing.
  if (account.group.key === 'admin') {
    html += '<hr class="sidebar-nav-divider">';
    html += ADMIN_ONLY_LINKS.map((item) => renderNavItem(item, currentPath)).join('');
    html += ADDON_LINKS.filter((item) => account[item.flag]).map((item) => renderNavItem(item, currentPath)).join('');
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
