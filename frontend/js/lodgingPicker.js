import { escapeHtml } from './formFields.js';

// The "Unterbringung" step (add-on "Unterkünfte"): every lodging of the event
// (hut, room, tent, ...) as a card with its free beds and -- for people who are
// part of the event -- who sleeps there, so families and groups can find each
// other. One bed per registration; a card is chosen with its radio button.

function formatCents(cents) {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

function lodgingCard(lodging, selectedId, disabled) {
  const mine = lodging.id === selectedId;
  const full = lodging.free === 0 && !mine;
  const occupants = lodging.occupants.length
    ? `<ul class="lodging-occupants">${lodging.occupants.map((o) => `<li>${escapeHtml(o.name)}</li>`).join('')}</ul>`
    : '<p class="sub">Noch niemand eingetragen.</p>';
  return `<label class="lodging-card${mine ? ' is-selected' : ''}${full ? ' is-full' : ''}">
    <input type="radio" name="lodging" value="${escapeHtml(lodging.id)}" ${mine ? 'checked' : ''} ${full || disabled ? 'disabled' : ''}>
    <span class="lodging-card-head">
      <strong>${escapeHtml(lodging.name)}</strong>
      <span class="lodging-card-beds">${full ? 'voll' : `${lodging.free} von ${lodging.beds} Betten frei`}</span>
    </span>
    ${lodging.priceCents > 0 ? `<span class="sub">${formatCents(lodging.priceCents)} pro Bett</span>` : ''}
    ${lodging.description ? `<span class="sub">${escapeHtml(lodging.description)}</span>` : ''}
    ${occupants}
  </label>`;
}

// '' when the event has no lodgings, so callers can drop it in unconditionally.
export function renderLodgingPicker(lodgings, selectedId = null, { disabled = false, allowNone = true } = {}) {
  if (!lodgings || lodgings.length === 0) return '';
  return `<div class="lodging-picker">
    ${allowNone ? `<label class="lodging-card${selectedId ? '' : ' is-selected'}">
      <input type="radio" name="lodging" value="" ${selectedId ? '' : 'checked'} ${disabled ? 'disabled' : ''}>
      <span class="lodging-card-head"><strong>Keine Unterkunft über uns</strong></span>
      <span class="sub">Ich kümmere mich selbst darum.</span>
    </label>` : ''}
    ${lodgings.map((l) => lodgingCard(l, selectedId, disabled)).join('')}
  </div>`;
}

// The chosen lodging id, or undefined for "none".
export function collectLodging(container) {
  return container.querySelector('input[name="lodging"]:checked')?.value || undefined;
}

// The registration step: hidden behind "Unterbringung mieten". Ticking it
// reveals the lodgings; unticking forgets the choice.
export function renderLodgingSection(lodgings) {
  if (!lodgings || lodgings.length === 0) return '';
  return `<h3>Unterbringung</h3>
    <label class="lodging-toggle"><input type="checkbox" data-lodging-toggle> Unterbringung mieten</label>
    <div data-lodging-panel hidden>
      <p class="sub">Wähle ein Bett. Du siehst, wer in welcher Unterkunft schläft – so finden Familien und Gruppen zusammen.</p>
      ${renderLodgingPicker(lodgings, null, { allowNone: false })}
    </div>`;
}

export function bindLodgingSection(container) {
  const toggle = container.querySelector('[data-lodging-toggle]');
  const panel = container.querySelector('[data-lodging-panel]');
  if (!toggle) return;
  toggle.addEventListener('change', () => {
    panel.hidden = !toggle.checked;
    if (!toggle.checked) container.querySelectorAll('input[name="lodging"]').forEach((r) => { r.checked = false; });
  });
}

// { wanted, lodgingId }: wanted without a chosen lodging means "pick one first".
export function collectLodgingSection(container) {
  const wanted = Boolean(container.querySelector('[data-lodging-toggle]')?.checked);
  return { wanted, lodgingId: wanted ? collectLodging(container) : undefined };
}

export { formatCents as formatLodgingCents };
