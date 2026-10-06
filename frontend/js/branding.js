// Kept in sync by hand with ALLOWED_CUSTOM_COLOR_KEYS in
// backend/appSettings/routes.js -- the browser has no access to backend
// modules to share this list directly.
export const CUSTOM_COLOR_KEYS = [
  'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container',
  'surface-container-high', 'surface-container-highest', 'on-surface', 'on-surface-variant',
  'outline', 'outline-variant', 'primary', 'primary-deep', 'primary-container', 'on-primary',
  'on-primary-container', 'gold', 'gold-container', 'on-gold-container', 'secondary',
  'secondary-container', 'error', 'success',
];

// Applies the instance-wide theme/color scheme to <html> -- shared by
// applyBranding() (actual settings, on every page load) and the Branding
// admin page's live preview (tentative form values, before saving).
export function applyColorScheme({ themeMode, colorScheme, customColors }) {
  const root = document.documentElement;
  root.dataset.theme = themeMode === 'dark' ? 'dark' : 'light';
  root.dataset.scheme = colorScheme || 'sahara';
  for (const key of CUSTOM_COLOR_KEYS) root.style.removeProperty(`--${key}`);
  if (colorScheme === 'custom' && customColors) {
    for (const [key, value] of Object.entries(customColors)) {
      if (CUSTOM_COLOR_KEYS.includes(key)) root.style.setProperty(`--${key}`, value);
    }
  }
}

// Background graphic: a built-in preset is a mask that takes the scheme's
// colour (shown behind the page and in the sidebar); 'custom' is the uploaded
// picture as it is; 'none' switches the graphic off.
export const BACKGROUND_PRESETS = [
  ['grunge', 'Verwittert'], ['netz', 'Netzwerk'], ['halle', 'Forschungshalle'], ['daten', 'Daten-Sog'],
  ['marmor', 'Marmor'], ['nebel', 'Nebel'], ['metall', 'Metall'], ['holz', 'Holz'], ['glitzer', 'Glitzer'],
];

export function applyBackground({ backgroundPreset, hasUploadedBackgroundImage, backgroundOpacity }) {
  const root = document.documentElement.style;
  const preset = backgroundPreset || 'grunge';
  const isMask = BACKGROUND_PRESETS.some(([key]) => key === preset);
  const opacity = (Number.isInteger(backgroundOpacity) ? backgroundOpacity : 20) / 100;
  root.setProperty('--bg-mask', isMask ? `url(/img/bg/${preset}.webp)` : 'none');
  root.setProperty('--bg-mask-opacity', isMask ? String(opacity) : '0');
  root.setProperty('--bg-image-opacity', String(opacity));
  root.setProperty('--app-bg-image', preset === 'custom' && hasUploadedBackgroundImage ? 'url(/app-settings/background-image)' : 'none');
}

export async function applyBranding() {
  let settings;
  try {
    const res = await fetch('/app-settings');
    if (!res.ok) return;
    settings = await res.json();
  } catch {
    return;
  }

  applyColorScheme(settings);
  applyBackground(settings);

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
