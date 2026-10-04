import { toCsv } from '../csv.js';

const STATUS_LABELS = { active: 'Aktiv', deactivated: 'Deaktiviert', invited: 'Eingeladen' };
const REGISTRATION_LABELS = {
  notified: 'Benachrichtigt', pending: 'Vorgemerkt', confirmed: 'Angemeldet', checked_in: 'Eingecheckt',
  checked_out: 'Ausgecheckt', cancelled: 'Abgesagt', waitlisted: 'Warteliste',
};

function memberKind(m) {
  if (m.status === 'invited') return 'Eingeladen';
  if (m.managedBy) return 'Verwaltete Person';
  return m.isGuest ? 'Gast' : 'Vollkonto';
}

// Builds the member-list CSV. `viewer` decides which account (OT) fields
// appear: only those the viewer's own group may see (the same rule the edit
// dialog uses), so the export never contains more than the screen would.
// Registrations are always part of the file: with `event` (the event chosen
// in the list's filter) one column holds that event's status; without it a
// single "Anmeldungen" column lists every event the member is registered for,
// e.g. "Sommercon 2027: Angemeldet; Wintercon 2027: Warteliste".
export function buildMembersCsv(members, { accountSchema, viewer, event, events = [] }) {
  const columns = [
    { label: 'Nachname', value: (m) => m.lastName },
    { label: 'Vorname', value: (m) => m.firstName },
    { label: 'Rufname', value: (m) => m.nickname },
    { label: 'Anzeigename', value: (m) => m.name },
    { label: 'E-Mail', value: (m) => m.email },
    { label: 'Gruppe', value: (m) => m.group?.name },
    { label: 'Status', value: (m) => STATUS_LABELS[m.status] ?? m.status },
    { label: 'Kontoart', value: memberKind },
    { label: 'Verwaltet von', value: (m) => m.managedBy?.name },
    { label: 'Discord', value: (m) => m.discordUsername },
  ];
  if (event) {
    columns.push({
      label: `Anmeldung: ${event.name}`,
      value: (m) => {
        const reg = (m.registrations ?? []).find((r) => r.eventId === event.id);
        return reg ? (REGISTRATION_LABELS[reg.status] ?? reg.status) : 'Nicht angemeldet';
      },
    });
  }
  else {
    const eventById = new Map(events.map((e) => [e.id, e]));
    columns.push({
      label: 'Anmeldungen',
      value: (m) => (m.registrations ?? [])
        .map((r) => ({ ...r, event: eventById.get(r.eventId) }))
        .sort((a, b) => String(a.event?.event_date ?? '').localeCompare(String(b.event?.event_date ?? '')))
        .map((r) => `${r.event?.name ?? 'Unbekanntes Event'}: ${REGISTRATION_LABELS[r.status] ?? r.status}`)
        .join('; '),
    });
  }
  const allowed = new Set(viewer.group.accountFields ?? []);
  for (const field of accountSchema.filter((f) => allowed.has(f.key))) {
    columns.push({ label: field.label ?? field.key, value: (m) => m[field.key] });
  }
  return toCsv(members, columns);
}
