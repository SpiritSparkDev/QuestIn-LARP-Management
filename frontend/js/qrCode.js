export function buildScanCode({ eventCode, groupKey, userId }) {
  return `${eventCode}-${groupKey}-${userId}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseScanCode(code) {
  if (typeof code !== 'string' || code.length < 38) return null;
  const userId = code.slice(-36);
  if (!UUID_PATTERN.test(userId)) return null;
  const rest = code.slice(0, -37);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash === -1) return null;
  const eventCode = rest.slice(0, lastDash);
  const groupKey = rest.slice(lastDash + 1);
  if (!eventCode || !groupKey) return null;
  return { eventCode, groupKey, userId };
}
