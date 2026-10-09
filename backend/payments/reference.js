// Bank transfer reference: the event's QR code identifier plus "Vorname-Nachname",
// e.g. "P17/2027 Anna-Muster". Without an identifier (or names) the old short
// id-based form is the fallback, so a reference is never empty.
export function buildPaymentReference(eventId, userId, { code, firstName, lastName } = {}) {
  const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  const name = [clean(firstName), clean(lastName)].filter(Boolean).join('-');
  const prefix = clean(code);
  if (prefix && name) return `${prefix} ${name}`.slice(0, 140);
  return `P-${eventId.slice(0, 8)}-${userId.slice(0, 8)}`.toUpperCase();
}
