export async function applyBranding() {
  let settings;
  try {
    const res = await fetch('/app-settings');
    if (!res.ok) return;
    settings = await res.json();
  } catch {
    return;
  }

  if (settings.appTitle) document.title = document.title.replace('Pakyrion', settings.appTitle);

  const brandName = document.querySelector('.brand-name, .sidebar-brand');
  if (brandName && settings.appTitle) {
    // .sidebar-brand has a nested <span>Admin</span> that must survive the rewrite.
    const span = brandName.querySelector('span');
    brandName.childNodes[0].textContent = settings.appTitle;
    if (span) brandName.appendChild(span);
  }

  if (settings.logoUrl) {
    const seal = document.querySelector('.brand-seal');
    if (seal) seal.innerHTML = `<img src="${settings.logoUrl}" alt="Logo">`;
  }
}
