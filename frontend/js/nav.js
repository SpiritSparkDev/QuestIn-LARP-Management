import { escapeHtml } from './formFields.js';

const MENU_LINKS = [
  { key: 'konto', label: 'Konto', href: '/account.html', icon: 'manage_accounts' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html', icon: 'group' },
  { key: 'events', label: 'Events', href: '/admin/events.html', icon: 'calendar_month' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html', icon: 'qr_code_scanner' },
];

export function renderNavLinks(account, currentPath) {
  const links = MENU_LINKS.filter((item) => account.menus.includes(item.key));
  if (account.group.key === 'admin') {
    links.push({ key: 'gruppen', label: 'Gruppen', href: '/admin/groups.html', icon: 'groups' });
    links.push({ key: 'einstellungen', label: 'Einstellungen', href: '/admin/settings.html', icon: 'settings' });
    links.push({ key: 'branding', label: 'Branding', href: '/admin/branding.html', icon: 'palette' });
    links.push({ key: 'speicher', label: 'Speicher', href: '/admin/storage.html', icon: 'storage' });
  }
  return links.map(({ href, label, icon }) => {
    const current = href === currentPath ? 'sidebar-nav-item current' : 'sidebar-nav-item';
    return `<a href="${href}" class="${current}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></a>`;
  }).join('');
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
  </div>`;
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
