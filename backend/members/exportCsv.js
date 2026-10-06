import { toCsv } from '../csv.js';

// Account fields that need the extra "can_export_sensitive" permission: health
// data by key, plus any field an admin marks `sensitive: true` in the schema.
const SENSITIVE_ACCOUNT_FIELD_KEYS = ['medicalNotes'];
export const isSensitiveField = (field) => field.sensitive === true || SENSITIVE_ACCOUNT_FIELD_KEYS.includes(field.key);

const STATUS_LABELS = { active: 'Aktiv', deactivated: 'Deaktiviert', invited: 'Eingeladen' };
const REGISTRATION_LABELS = {
  notified: 'Benachrichtigt', pending: 'Angemeldet, noch nicht bezahlt', confirmed: 'Bestätigt', checked_in: 'Eingecheckt',
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
// Registrations are always part of the file, one column per event: with
// `event` (the event chosen in the list's filter) just that event, otherwise
// every event at least one exported member is registered for, oldest first.
// Each cell holds the member's status for that event, or "Nicht angemeldet".
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
  const registrationColumn = (ev) => ({
    label: `Anmeldung: ${ev.name}`,
    value: (m) => {
      const reg = (m.registrations ?? []).find((r) => r.eventId === ev.id);
      return reg ? (REGISTRATION_LABELS[reg.status] ?? reg.status) : 'Nicht angemeldet';
    },
  });
  const registeredEventIds = new Set(members.flatMap((m) => (m.registrations ?? []).map((r) => r.eventId)));
  const eventColumns = event
    ? [event]
    : events
      .filter((e) => registeredEventIds.has(e.id))
      .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  columns.push(...eventColumns.map(registrationColumn));
  const allowed = new Set(viewer.group.accountFields ?? []);
  const mayExportSensitive = viewer.group.canExportSensitive === true;
  for (const field of accountSchema.filter((f) => allowed.has(f.key) && (mayExportSensitive || !isSensitiveField(f)))) {
    columns.push({ label: field.label ?? field.key, value: (m) => m[field.key] });
  }
  return toCsv(members, columns);
}
