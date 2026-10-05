import { escapeHtml } from './formFields.js';

// The "Unterbringung" step (add-on "Unterkünfte"): every lodging of the event
// (hut, room, tent, ...) as a card with its free beds and -- for people who are
// part of the event -- who sleeps there, so families and groups can find each
// other. One bed per registration; a card is chosen with its radio button.

function formatCents(cents) {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

export function formatTent(details) {
  if (!details) return '';
  const metres = (cm) => (cm / 100).toFixed(1).replace('.', ',');
  const type = details.tentType === 'it' ? 'IT' : 'OT';
  return details.lengthCm ? `${metres(details.lengthCm)} × ${metres(details.widthCm)} m, ${type}` : `${type}-Zelt`;
}

// Size and IT/OT of the tent, shown while a pitch card is selected.
function pitchDetailsFields(details, visible, id) {
  const metres = (cm) => (cm ? (cm / 100).toString() : '');
  const type = details?.tentType;
  const hasSize = Boolean(details?.lengthCm);
  return `<span class="lodging-pitch-details" data-pitch-details ${visible ? '' : 'hidden'}>
    <span class="lodging-pitch-type">
      <label><input type="radio" name="tent-type-${id}" value="it" data-tent-type ${type === 'it' ? 'checked' : ''}> IT-Zelt (Spielwelt)</label>
      <label><input type="radio" name="tent-type-${id}" value="ot" data-tent-type ${type === 'ot' ? 'checked' : ''}> OT-Zelt (außerhalb der Spielwelt)</label>
    </span>
    <label class="lodging-pitch-size-toggle"><input type="checkbox" data-tent-size-toggle ${hasSize ? 'checked' : ''}> Maße des Zeltes angeben</label>
    <span class="lodging-pitch-row" data-tent-size ${hasSize ? '' : 'hidden'}>
      <span><input type="number" data-tent-length min="0.5" max="30" step="0.1" value="${metres(details?.lengthCm)}"><label>Länge (m)</label></span>
      <span><input type="number" data-tent-width min="0.5" max="30" step="0.1" value="${metres(details?.widthCm)}"><label>Breite (m)</label></span>
    </span>
  </span>`;
}

function lodgingCard(lodging, selectedId, disabled, selectedDetails) {
  const pitch = lodging.kind === 'pitch';
  const mine = lodging.id === selectedId;
  const full = !lodging.unlimited && lodging.free === 0 && !mine;
  const occupants = lodging.occupants.length
    ? `<ul class="lodging-occupants">${lodging.occupants.map((o) => `<li>${escapeHtml(o.name)}${o.details ? ` <span class="sub">${escapeHtml(formatTent(o.details))}</span>` : ''}</li>`).join('')}</ul>`
    : '<p class="sub">Noch niemand eingetragen.</p>';
  return `<label class="lodging-card${mine ? ' is-selected' : ''}${full ? ' is-full' : ''}">
    <input type="radio" name="lodging" value="${escapeHtml(lodging.id)}" ${lodging.isDefault ? 'data-default' : ''} ${mine ? 'checked' : ''} ${full || disabled ? 'disabled' : ''}>
    <span class="lodging-card-head">
      <strong>${escapeHtml(lodging.name)}${lodging.isDefault ? ' <span class="tag">Standard</span>' : ''}</strong>
      <span class="lodging-card-beds">${full ? 'voll' : (lodging.unlimited ? 'beliebig viele Plätze' : `${lodging.free} von ${lodging.beds} ${pitch ? 'Zeltplätzen' : 'Betten'} frei`)}</span>
    </span>
    ${lodging.priceCents > 0 ? `<span class="sub">${formatCents(lodging.priceCents)} pro ${pitch ? 'Zeltplatz' : 'Bett'}</span>` : (pitch ? '<span class="sub">kostenlos</span>' : '')}
    ${lodging.description ? `<span class="sub">${escapeHtml(lodging.description)}</span>` : ''}
    ${pitch ? pitchDetailsFields(mine ? selectedDetails : null, mine, lodging.id) : ''}
    ${occupants}
  </label>`;
}

// '' when the event has no lodgings, so callers can drop it in unconditionally.
export function renderLodgingPicker(lodgings, selectedId = null, { disabled = false, allowNone = true, selectedDetails = null } = {}) {
  if (!lodgings || lodgings.length === 0) return '';
  return `<div class="lodging-picker">
    ${allowNone ? `<label class="lodging-card${selectedId ? '' : ' is-selected'}">
      <input type="radio" name="lodging" value="" ${selectedId ? '' : 'checked'} ${disabled ? 'disabled' : ''}>
      <span class="lodging-card-head"><strong>Keine Unterkunft über uns</strong></span>
      <span class="sub">Ich kümmere mich selbst darum.</span>
    </label>` : ''}
    ${lodgings.map((l) => lodgingCard(l, selectedId, disabled, selectedDetails)).join('')}
  </div>`;
}

// The chosen lodging id, or undefined for "none".
export function collectLodging(container) {
  return container.querySelector('input[name="lodging"]:checked')?.value || undefined;
}

// Shows the tent fields only on the selected pitch card.
export function bindLodgingPicker(container) {
  const update = () => {
    container.querySelectorAll('.lodging-card').forEach((card) => {
      const selected = card.querySelector('input[name="lodging"]')?.checked;
      card.classList.toggle('is-selected', Boolean(selected));
      const details = card.querySelector('[data-pitch-details]');
      if (details) details.hidden = !selected;
    });
  };
  container.querySelectorAll('input[name="lodging"]').forEach((r) => r.addEventListener('change', update));
  container.querySelectorAll('[data-tent-size-toggle]').forEach((box) => {
    box.addEventListener('change', () => { box.closest('[data-pitch-details]').querySelector('[data-tent-size]').hidden = !box.checked; });
  });
  update();
  return update;
}

// The chosen lodging with its tent details, or an error text when a pitch
// is chosen without a complete tent description.
export function collectLodgingChoice(container) {
  const checked = container.querySelector('input[name="lodging"]:checked');
  if (!checked || !checked.value) return {};
  const fields = checked.closest('.lodging-card').querySelector('[data-pitch-details]');
  if (!fields) return { lodgingId: checked.value };
  const type = fields.querySelector('[data-tent-type]:checked')?.value;
  if (!type) return { lodgingId: checked.value, error: 'Bitte angeben, ob dein Zelt ein IT- oder OT-Zelt ist.' };
  if (!fields.querySelector('[data-tent-size-toggle]').checked) return { lodgingId: checked.value, lodgingDetails: { tentType: type } };
  const length = Number(fields.querySelector('[data-tent-length]').value.replace(',', '.'));
  const width = Number(fields.querySelector('[data-tent-width]').value.replace(',', '.'));
  if (!(length >= 0.5) || !(width >= 0.5)) {
    return { lodgingId: checked.value, error: 'Bitte Länge und Breite deines Zelts angeben oder das Häkchen bei den Maßen entfernen.' };
  }
  return { lodgingId: checked.value, lodgingDetails: { lengthCm: Math.round(length * 100), widthCm: Math.round(width * 100), tentType: type } };
}

// The registration step. An optional default lodging (usually the free tent
// pitch) is always shown and preselected; the others appear after switching on
// "Unterbringung mieten". Without a default, everything is behind the switch.
export function renderLodgingSection(lodgings) {
  if (!lodgings || lodgings.length === 0) return '';
  const standard = lodgings.find((l) => l.isDefault);
  const others = lodgings.filter((l) => !l.isDefault);
  const standardFree = standard && (standard.unlimited || standard.free > 0);
  const intro = standard
    ? 'Dein Standard-Platz ist vorausgewählt. Mit „Unterbringung mieten“ siehst du weitere Möglichkeiten und wer wo schläft – so finden Familien und Gruppen zusammen.'
    : 'Wähle ein Bett. Du siehst, wer in welcher Unterkunft schläft – so finden Familien und Gruppen zusammen.';
  return `<div class="card form-pad lodging-section">
    <h3>Unterbringung</h3>
    ${standard ? `<p class="sub">${intro}</p>${renderLodgingPicker([standard], standardFree ? standard.id : null, { allowNone: false })}` : ''}
    ${others.length ? `<label class="switch-row"><input type="checkbox" class="switch" data-lodging-toggle> Unterbringung mieten</label>
    <div data-lodging-panel hidden>
      ${standard ? '' : `<p class="sub">${intro}</p>`}
      ${renderLodgingPicker(others, null, { allowNone: false })}
    </div>` : ''}
  </div>`;
}

export function bindLodgingSection(container) {
  const update = bindLodgingPicker(container);
  const toggle = container.querySelector('[data-lodging-toggle]');
  const panel = container.querySelector('[data-lodging-panel]');
  if (!toggle) return;
  toggle.addEventListener('change', () => {
    panel.hidden = !toggle.checked;
    if (!toggle.checked) {
      // Back to the default (if there is one and it has room), otherwise nothing.
      container.querySelectorAll('input[name="lodging"]').forEach((r) => { r.checked = false; });
      const standard = container.querySelector('input[name="lodging"][data-default]:not([disabled])');
      if (standard) standard.checked = true;
      update();
    }
  });
}

// { wanted, lodgingId, lodgingDetails, error }: wanted without a chosen lodging means "pick one first".
export function collectLodgingSection(container) {
  const wanted = Boolean(container.querySelector('[data-lodging-toggle]')?.checked);
  return { wanted, ...collectLodgingChoice(container) };
}

export { formatCents as formatLodgingCents };
