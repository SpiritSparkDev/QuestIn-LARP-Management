// Numbers from the QuestIn hub for this org's published events: views of the
// event page on questin.de and clicks on "Zur Anmeldung" (questin-hub
// docs/feed-format.md, GET /api/org/stats). Read server side with the hub
// client credentials; the hub only counts, it knows nothing about persons.
import { hubConfig } from './config.js';
import { logger } from '../logger.js';

const TIMEOUT_MS = 5_000;
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

export function resetHubStatsCache() {
  cache = null;
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

// { enabled, events: { [eventId]: { views, clicks, last30Days: { views, clicks } } }, orgs: [{ name, slug }] }
export async function hubEventStats(fetchImpl = fetch, now = Date.now()) {
  const config = hubConfig();
  if (!config) return { enabled: false, events: {}, orgs: [] };
  if (cache && cache.until > now) return cache.value;
  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64');
  let value;
  try {
    const res = await fetchImpl(new URL('/api/org/stats', config.issuer), {
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const events = {};
    const orgs = [];
    for (const org of Array.isArray(body?.orgs) ? body.orgs : []) {
      if (typeof org?.slug === 'string') orgs.push({ name: String(org.name ?? ''), slug: org.slug });
      for (const e of Array.isArray(org?.events) ? org.events : []) {
        if (typeof e?.externalId !== 'string') continue;
        events[e.externalId] = {
          views: count(e.views),
          clicks: count(e.clicks),
          last30Days: { views: count(e.last30Days?.views), clicks: count(e.last30Days?.clicks) },
        };
      }
    }
    value = { enabled: true, events, orgs };
  } catch (err) {
    logger.warn('hub stats unavailable', { error: err.name === 'TimeoutError' ? 'timeout' : err.message });
    // Not cached, so the next page load tries again.
    return { enabled: true, unavailable: true, events: {}, orgs: [] };
  }
  cache = { until: now + CACHE_MS, value };
  return value;
}
