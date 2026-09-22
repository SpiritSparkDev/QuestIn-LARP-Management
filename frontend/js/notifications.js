const AUTO_DISMISS_MS = { success: 4000, info: 4000, error: 7000 };
const ICONS = { success: 'check_circle', error: 'error', info: 'info' };

let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('dialog');
  container.id = 'toast-stack';
  document.body.appendChild(container);
  return container;
}

// Shows a transient notification for any success/error/info feedback that
// used to live in a page's own <p id="...message"> element. Renders as a
// non-modal <dialog> re-shown on every call so it re-enters the browser's
// top layer above whatever modal <dialog> (if any) is currently open --
// otherwise a native dialog's own top-layer stacking would bury it behind
// an open confirm/edit dialog regardless of z-index.
export function notify(message, type = 'info') {
  if (!message) return;
  const stack = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="material-symbols-outlined toast-icon" aria-hidden="true">${ICONS[type] ?? ICONS.info}</span>
    <span class="toast-text"></span>
    <button type="button" class="toast-close" aria-label="Schließen"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
  `;
  toast.querySelector('.toast-text').textContent = message;

  const dismissMs = AUTO_DISMISS_MS[type] ?? AUTO_DISMISS_MS.info;
  const timeoutId = setTimeout(() => toast.remove(), dismissMs);
  toast.querySelector('.toast-close').addEventListener('click', () => {
    clearTimeout(timeoutId);
    toast.remove();
  });

  stack.appendChild(toast);
  if (stack.open) stack.close();
  stack.show();
}
