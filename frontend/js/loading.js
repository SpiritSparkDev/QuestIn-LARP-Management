// Hides the full-screen #page-loader markup (present in the page's own
// static HTML, so it's visible from first paint -- no JS needed to show it,
// only to hide it once the page's own init data has loaded).
export function hideLoading() {
  const el = document.getElementById('page-loader');
  if (!el) return;
  el.classList.add('page-loader-hidden');
  setTimeout(() => el.remove(), 250);
}
