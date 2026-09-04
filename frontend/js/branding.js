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

  const seal = document.querySelector('.brand-seal');
  if (seal && (settings.hasUploadedLogo || settings.logoUrl)) {
    const img = document.createElement('img');
    img.src = settings.hasUploadedLogo ? '/app-settings/logo' : settings.logoUrl;
    img.alt = 'Logo';
    seal.replaceChildren(img);
    // Wait for the brand font to be ready so the width measured below
    // isn't taken from a fallback-font layout that's about to shift.
    if (document.fonts) await document.fonts.ready;
    if (brandName) seal.style.width = `${brandName.getBoundingClientRect().width}px`;
    seal.style.display = 'block';
  } else if (seal) {
    seal.replaceChildren();
    seal.style.display = 'none';
  }
}
