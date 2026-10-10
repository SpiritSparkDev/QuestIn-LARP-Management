import { escapeHtml } from './formFields.js';

// Shared by the Versandprotokoll page (admin/email-log.html) and the
// member detail (admin/members.html).
export const EMAIL_STATUS = {
  sent: { label: 'Versendet', badge: 'badge-active' },
  failed: { label: 'Fehlgeschlagen', badge: 'badge-failed' },
  not_configured: { label: 'Nicht versendet (kein SMTP)', badge: 'badge-failed' },
  queued: { label: 'Offline gesammelt', badge: 'badge-inactive' },
  skipped: { label: 'Übersprungen', badge: 'badge-inactive' },
};

const formatTime = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

export function renderEmailLogRows(entries, slotLabels = {}, { withRecipient = true } = {}) {
  return entries.map((e) => {
    const status = EMAIL_STATUS[e.status] ?? { label: e.status, badge: 'badge-inactive' };
    const error = e.error && e.status !== 'sent' ? `<div class="sub" style="margin-top:4px;">${escapeHtml(e.error)}</div>` : '';
    return `<tr>
      <td>${escapeHtml(formatTime(e.createdAt))}</td>
      <td>${escapeHtml(slotLabels[e.slot] ?? e.slot ?? '–')}</td>
      ${withRecipient ? `<td>${escapeHtml(e.to)}</td>` : ''}
      <td>${escapeHtml(e.subject)}</td>
      <td><span class="badge ${status.badge}">${escapeHtml(status.label)}</span>${error}</td>
    </tr>`;
  }).join('');
}
