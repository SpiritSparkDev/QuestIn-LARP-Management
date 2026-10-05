import { escapeHtml } from './formFields.js';

// Quantity picker for an event's bookable extras (cabin, vehicle pitch, ...).
// Shared by the registration form, the "edit registration" dialog, the
// managed-person page and the admin's member dialog.

const MAX_QUANTITY = 20;

export function formatCents(cents) {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

export function extrasTotalCents(extras, booked) {
  return extras.reduce((sum, e) => sum + (booked[e.id] ?? 0) * e.priceCents, 0);
}

// "2× Hütte, 1× Stellplatz" -- empty when nothing is booked.
export function extrasSummary(extras, booked = {}) {
  return Object.entries(booked)
    .map(([id, quantity]) => `${quantity}× ${extras.find((e) => e.id === id)?.name ?? 'Unbekanntes Extra'}`)
    .join(', ');
}

// Returns '' for an event without extras, so callers can drop it in unconditionally.
export function renderExtrasPicker(extras, booked = {}, { disabled = false } = {}) {
  if (!extras || extras.length === 0) return '';
  return `<div class="extras-picker">
    ${extras.map((extra) => `
      <div class="extras-picker-row">
        <div>
          <input type="number" data-extra-id="${escapeHtml(extra.id)}" min="0" max="${MAX_QUANTITY}" step="1" value="${booked[extra.id] ?? 0}" ${disabled ? 'disabled' : ''}>
          <label>${escapeHtml(extra.name)} <span class="sub">${formatCents(extra.priceCents)} pro Stück${extra.capacity ? `, Kontingent ${extra.capacity}` : ''}</span></label>
          ${extra.description ? `<p class="sub">${escapeHtml(extra.description)}</p>` : ''}
        </div>
      </div>`).join('')}
    <p class="sub" data-extras-total></p>
  </div>`;
}

// { extraId: quantity } of everything above zero.
export function collectExtras(container) {
  const booked = {};
  container.querySelectorAll('[data-extra-id]').forEach((input) => {
    const quantity = Number.parseInt(input.value, 10);
    if (quantity > 0) booked[input.dataset.extraId] = quantity;
  });
  return booked;
}

// Keeps the "Extras: 45,00 €" line under the picker current while typing.
export function wireExtrasTotal(container, extras) {
  const total = container.querySelector('[data-extras-total]');
  if (!total) return;
  const update = () => {
    const cents = extrasTotalCents(extras, collectExtras(container));
    total.textContent = cents > 0 ? `Extras gesamt: ${formatCents(cents)}` : '';
  };
  container.querySelectorAll('[data-extra-id]').forEach((input) => input.addEventListener('input', update));
  update();
}

// True when two quantity maps book the same things.
export function sameExtras(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? 0) === (b[key] ?? 0));
}
