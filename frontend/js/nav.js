const MENU_LINKS = [
  { key: 'konto', label: 'Konto', href: '/account.html' },
  { key: 'charaktere', label: 'Charaktere', href: '/characters.html' },
  { key: 'con-anmeldungen', label: 'Con-Anmeldungen', href: '/con-anmeldungen.html' },
  { key: 'mitglieder', label: 'Mitglieder', href: '/admin/members.html' },
  { key: 'events', label: 'Events', href: '/admin/events.html' },
  { key: 'checkin', label: 'Check-In', href: '/admin/checkin.html' },
];

export function renderNavLinks(account, currentPath) {
  const links = MENU_LINKS.filter((item) => account.menus.includes(item.key));
  if (account.group.key === 'admin') {
    links.push({ key: 'gruppen', label: 'Gruppen', href: '/admin/groups.html' });
    links.push({ key: 'einstellungen', label: 'Einstellungen', href: '/admin/settings.html' });
    links.push({ key: 'branding', label: 'Branding', href: '/admin/branding.html' });
    links.push({ key: 'speicher', label: 'Speicher', href: '/admin/storage.html' });
  }
  return links.map(({ href, label }) => {
    const current = href === currentPath ? ' class="current"' : '';
    return `<a href="${href}"${current}>${label}</a>`;
  }).join('');
}
