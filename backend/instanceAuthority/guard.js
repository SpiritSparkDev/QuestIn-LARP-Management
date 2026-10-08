import { getDelegation } from './repository.js';

const CHECKIN = /^\/events\/([^/]+)\/(?:checkin(?:\/[^/]+)?|checkout)$/;

// While an event is delegated to an offline instance, its check-in/checkout and
// every tavern write are locked here. Returns a 423 result or null.
// ponytail: tavern writes lock when ANY event is delegated (accounts/items aren't addressable by event in the URL); per-event lookup if parallel events matter.
export async function checkWriteGuard(method, pathname) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  let eventId;
  const match = CHECKIN.exec(pathname);
  if (match) eventId = match[1];
  else if (!pathname.startsWith('/tavern/')) return null;
  if (eventId && !/^[0-9a-f-]{36}$/i.test(eventId)) return null;
  const delegation = await getDelegation(eventId);
  if (!delegation) return null;
  const stand = new Date(delegation.snapshot_taken_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' });
  return { status: 423, body: { error: `Check-in/Taverne laufen gerade offline (Snapshot vom ${stand}).` } };
}
