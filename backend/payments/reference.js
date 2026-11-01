const ROLE_LABELS = { sc: 'SC', nsc: 'NSC', ticket: 'Ticket', helfer: 'Helfer', orga: 'Orga', hilfs_orga: 'Hilfs-Orga' };

// Bank transfer reference: by default the event's QR code identifier plus
// "Vorname-Nachname", e.g. "P17/2027 Anna-Muster". With an admin `template`
// ("{code} {rolle} {name}") the placeholders are filled in instead; an empty
// result falls back like the default. Without an identifier (or names) the old
// short id-based form is the fallback, so a reference is never empty.
export function buildPaymentReference(eventId, userId, { code, firstName, lastName, eventName, role, template } = {}) {
  const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  const name = [clean(firstName), clean(lastName)].filter(Boolean).join('-');
  const prefix = clean(code);
  const fallback = `P-${eventId.slice(0, 8)}-${userId.slice(0, 8)}`.toUpperCase();
  if (template?.trim()) {
    const vars = { code: prefix, event: clean(eventName), vorname: clean(firstName), nachname: clean(lastName), name, rolle: ROLE_LABELS[role] ?? clean(role), id: fallback };
    // 140 chars is the EPC QR limit for the purpose field.
    const text = clean(template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')).replace(/\s+/g, ' ').slice(0, 140).trim();
    if (text) return text;
  }
  if (prefix && name) return `${prefix} ${name}`.slice(0, 140);
  return fallback;
}

export const DEFAULT_GROUP_REFERENCE_TEMPLATE = '{code} {zahler}: {personen}';

// One transfer from a group manager for several people. Placeholders: {code},
// {event}, {zahler} (Vorname-Nachname of the payer), {gruppe}, {personen}
// (first names, comma-separated), {anzahl}, {id}.
export function buildGroupPaymentReference(eventId, payerId, { code, eventName, payerFirstName, payerLastName, groupName, personNames = [], template } = {}) {
  const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  const vars = {
    code: clean(code), event: clean(eventName), gruppe: clean(groupName),
    zahler: [clean(payerFirstName), clean(payerLastName)].filter(Boolean).join('-'),
    personen: personNames.map(clean).filter(Boolean).join(', '), anzahl: String(personNames.length),
    id: `P-${eventId.slice(0, 8)}-${payerId.slice(0, 8)}`.toUpperCase(),
  };
  const fill = (t) => clean(t.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')).replace(/\s+/g, ' ').slice(0, 140).trim();
  return (template?.trim() && fill(template)) || fill(DEFAULT_GROUP_REFERENCE_TEMPLATE) || vars.id;
}
