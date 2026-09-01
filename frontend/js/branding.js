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
    // .sidebar-brand has a nested <span>Admin</span> after the text node;
    // only the text node's data changes, so the span is untouched already.
    brandName.childNodes[0].textContent = settings.appTitle;
  }

  if (settings.logoUrl) {
    const seal = document.querySelector('.brand-seal');
    if (seal) {
      const img = document.createElement('img');
      img.src = settings.logoUrl;
      img.alt = 'Logo';
      seal.replaceChildren(img);
    }
  }
}
