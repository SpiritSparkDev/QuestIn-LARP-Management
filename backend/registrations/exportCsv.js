import { toCsv } from '../csv.js';
import { isSensitiveField } from '../members/exportCsv.js';

const CON_ROLE_LABELS = { sc: 'SC', nsc: 'NSC', helfer: 'Helfer', orga: 'Orga', hilfs_orga: 'Hilfs-Orga', ticket: 'Gast-Ticket' };
const STATUS_LABELS = {
  notified: 'Benachrichtigt', pending: 'Vorgemerkt', confirmed: 'Angemeldet', checked_in: 'Eingecheckt',
  checked_out: 'Ausgecheckt', cancelled: 'Abgesagt', waitlisted: 'Warteliste',
};
const PAYMENT_METHOD_LABELS = { stripe_card: 'Karte', stripe_paypal: 'PayPal', bank_transfer: 'Überweisung', stripe_bank_transfer: 'Überweisung (Stripe)' };

const euros = (cents) => (cents == null ? '' : (cents / 100).toFixed(2).replace('.', ','));
const dateTime = (value) => (value ? new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : '');

// CSV of the check-in list. Out-of-time (OT) columns are limited to the
// fields the viewer's group may see; sensitive ones also need the separate
// export-sensitive permission (same rule as the member export).
export function buildParticipantsCsv(participants, { otFields, viewer }) {
  const columns = [
    { label: 'Name', value: (p) => p.name },
    { label: 'Charaktere', value: (p) => (p.characters ?? []).map((c) => c.name).join(', ') },
    { label: 'Rolle', value: (p) => CON_ROLE_LABELS[p.conRole] ?? p.conRole },
    { label: 'Sonderrollen', value: (p) => (p.flags ?? []).join(', ') },
    { label: 'Status', value: (p) => STATUS_LABELS[p.status] ?? p.status },
    { label: 'Teilnahmegruppe', value: (p) => p.priceGroup },
    { label: 'Betrag (€)', value: (p) => euros(p.amountDueCents) },
    { label: 'Rabatt (€)', value: (p) => euros(p.discountCents || null) },
    { label: 'Bezahlt am', value: (p) => dateTime(p.paidAt) },
    { label: 'Zahlungsart', value: (p) => PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod },
    { label: 'Eingecheckt um', value: (p) => dateTime(p.checkedInAt) },
    { label: 'Ausgecheckt um', value: (p) => dateTime(p.checkedOutAt) },
  ];
  const allowed = new Set(viewer.group.accountFields ?? []);
  const mayExportSensitive = viewer.group.canExportSensitive === true;
  for (const field of otFields.filter((f) => allowed.has(f.key) && (mayExportSensitive || !isSensitiveField(f)))) {
    columns.push({ label: field.label ?? field.key, value: (p) => p.otFields?.[field.key] });
  }
  return toCsv(participants, columns);
}
