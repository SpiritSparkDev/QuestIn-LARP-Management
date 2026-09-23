export function buildPaymentReference(eventId, userId) {
  return `P-${eventId.slice(0, 8)}-${userId.slice(0, 8)}`.toUpperCase();
}
