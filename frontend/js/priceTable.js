// Price list for one Teilnahmegruppe: one line per Preisstufe with the dates it applies to and the
// price of the chosen group -- stacked, so it fits phone widths.
import { escapeHtml } from './formFields.js';

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const day = (iso) => dateFmt.format(new Date(`${iso}T00:00:00Z`));
const nextDay = (iso) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

// "bis 01.01.2027", "02.01.2027 – 01.07.2027", "ab 02.07.2027" or "ohne Frist".
export function tierRangeLabel(tiers, index) {
  const until = tiers[index].until ?? null;
  const from = index > 0 && tiers[index - 1].until ? nextDay(tiers[index - 1].until) : null;
  if (from && until) return `${day(from)} – ${day(until)}`;
  if (until) return `bis ${day(until)}`;
  if (from) return `ab ${day(from)}`;
  return 'ohne Frist';
}

// The stage that applies on `today` (first one whose deadline is not over), like the server does.
export function currentTierName(tiers, today = new Date().toISOString().slice(0, 10)) {
  return tiers.find((t) => t.until == null || today <= t.until)?.name ?? null;
}

// `highlight`: name of the stage to mark (the one valid today, or the one a registration was booked in).
export function renderPriceTable(pricing, group, { highlight = currentTierName(pricing?.tiers ?? []) } = {}) {
  const tiers = pricing?.tiers ?? [];
  if (!group || !(pricing?.groups ?? []).includes(group) || tiers.length === 0) return '';
  const rows = tiers.map((t, i) => {
    const cents = t.amounts?.[group];
    return `<li class="${t.name === highlight ? 'is-current' : ''}">
      <span class="price-table-label">
        <strong>${escapeHtml(t.name)}</strong>
        <span class="price-table-range">${escapeHtml(tierRangeLabel(tiers, i))}</span>
        ${t.conPayer ? '<span class="price-table-tag">Zahlung vor Ort</span>' : ''}
      </span>
      <span class="price-table-amount">${Number.isInteger(cents) ? euroFmt.format(cents / 100) : '–'}</span>
    </li>`;
  }).join('');
  return `<div class="price-table-wrap">
    <p class="price-table-caption">Preise für „${escapeHtml(group)}“ im Zeitverlauf</p>
    <ul class="price-table">${rows}</ul>
  </div>`;
}
