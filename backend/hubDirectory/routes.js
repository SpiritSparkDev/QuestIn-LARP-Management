import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { isOffline } from '../appMode.js';
import { getAppSettings } from '../appSettings/repository.js';
import { hubUrl } from './config.js';
import { getDirectoryCache, listPublishedEvents } from './repository.js';
import { getEvent } from '../events/repository.js';
import { availabilityOf, priceFromCents } from './details.js';

// Public feed for the QuestIn hub (format v1 with the optional v1.1 fields, see
// questin-hub docs/feed-format.md). Only event facts and a link: no personal data.
router.get('/public/directory/events.json', async () => {
  if (isOffline()) return { status: 404, body: { error: 'not available offline' } };
  const origin = new URL((await getAppSettings()).effectiveBaseUrl).origin;
  const published = await listPublishedEvents();
  const events = [];
  for (const e of published) {
    const full = await getEvent(e.id);
    events.push({ ...e, full, availability: await availabilityOf(full) });
  }
  return {
    status: 200,
    headers: { 'Cache-Control': 'public, max-age=300' },
    body: {
      version: 1,
      events: events.map((e) => ({
        id: e.id,
        name: e.name,
        startDate: e.event_date,
        endDate: e.end_date,
        // The address is only meant for registered participants (061_event_location), so it is not published.
        location: null,
        color: e.color && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : null,
        url: `${origin}/`,
        registrationOpensAt: e.full.registration_opens_at ? new Date(e.full.registration_opens_at).toISOString() : null,
        availability: e.availability,
        region: e.full.directory_region ?? null,
        genres: e.full.directory_genres ?? [],
        priceFromCents: priceFromCents(e.full.pricing),
      })),
    },
  };
});

// Other orgs' events for logged-in participants, from the stored copy.
router.get('/hub-directory', requireAuth(async () => {
  if (!hubUrl() || isOffline()) return { status: 200, body: { enabled: false, events: [] } };
  const cache = await getDirectoryCache();
  const day = new Date().toISOString().slice(0, 10);
  const events = (cache.events ?? []).filter((e) => (e.endDate ?? e.startDate) >= day);
  return { status: 200, body: { enabled: true, events, updatedAt: cache.last_success_at } };
}));
