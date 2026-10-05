import { escapeHtml } from './formFields.js';

// The event's special roles ("Sonderrollen") as cards with a short
// description each. A card is ticked with its checkbox; any number can be chosen.

// '' when the event has no special roles, so callers can drop it in unconditionally.
export function renderFlagCards(event, selected = []) {
  const flags = event?.flags ?? [];
  if (flags.length === 0) return '';
  const details = event.flag_details ?? {};
  return `<div class="flag-picker">${flags.map((flag) => `
    <label class="flag-card${selected.includes(flag) ? ' is-selected' : ''}">
      <input type="checkbox" data-flag="${escapeHtml(flag)}" ${selected.includes(flag) ? 'checked' : ''}>
      <span class="flag-card-name">${escapeHtml(flag)}</span>
      ${details[flag] ? `<span class="sub">${escapeHtml(details[flag])}</span>` : ''}
    </label>`).join('')}</div>`;
}

export function collectFlagCards(container) {
  return [...container.querySelectorAll('input[data-flag]:checked')].map((box) => box.dataset.flag);
}

// Highlights ticked cards (the checkbox keeps working without it).
export function bindFlagCards(container) {
  container.querySelectorAll('.flag-card input').forEach((box) => {
    box.addEventListener('change', () => box.closest('.flag-card').classList.toggle('is-selected', box.checked));
  });
}
