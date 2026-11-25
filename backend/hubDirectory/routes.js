import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireMenu } from '../middleware/authorize.js';
import { hubEventStats } from './stats.js';
import { isOffline } from '../appMode.js';
import { getAppSettings } from '../appSettings/repository.js';
import { hubUrl } from './config.js';
import { getDirectoryCache, listPublishedEvents } from './repository.js';
import { getEvent } from '../events/repository.js';
import { availabilityOf, priceFromCents, imageTypeOf, setDirectoryImage, getDirectoryImage, MAX_DIRECTORY_IMAGE_BYTES } from './details.js';
import { readJsonBody } from '../httpBody.js';
import { logAudit } from '../audit/repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public feed for the QuestIn hub (format v1 with the optional v1.1/v1.2 fields, see
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
        teaser: e.full.directory_teaser || null,
        imageUrl: e.full.has_directory_image ? `${origin}/public/directory/events/${e.id}/image?v=${new Date(e.full.directory_image_updated_at).getTime()}` : null,
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

// Views and clicks of the own published events on questin.de (event form).
router.get('/hub-directory/stats', requireAuth(requireMenu('events')(async () => {
  if (isOffline()) return { status: 200, body: { enabled: false, events: {}, orgs: [] } };
  return { status: 200, body: await hubEventStats() };
})));

// Titelbild eines veröffentlichten Events, für den Hub (Feed v1.2 `imageUrl`).
router.get('/public/directory/events/:id/image', async ({ params }) => {
  if (isOffline() || !UUID_RE.test(params.id)) return { status: 404, body: { error: 'not found' } };
  const image = await getDirectoryImage(params.id);
  if (!image) return { status: 404, body: { error: 'not found' } };
  return { status: 200, isBinary: true, body: image.data, headers: { 'Content-Type': image.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } };
});

// Titelbild hochladen/entfernen (Event-Formular, wie Logo-Upload: JSON mit base64).
router.put('/events/:id/directory-image', requireAuth(requireMenu('events')(async ({ req, params, user }) => {
  if (!UUID_RE.test(params.id)) return { status: 404, body: { error: 'event not found' } };
  const body = await readJsonBody(req, Math.ceil(MAX_DIRECTORY_IMAGE_BYTES * 1.4) + 1024);
  if (body === null || typeof body.dataBase64 !== 'string') return { status: 400, body: { error: 'dataBase64 must be a base64 string' } };
  const data = Buffer.from(body.dataBase64, 'base64');
  if (data.length === 0) return { status: 400, body: { error: 'dataBase64 is required' } };
  if (data.length > MAX_DIRECTORY_IMAGE_BYTES) return { status: 413, body: { error: 'image exceeds the 1MB limit' } };
  const type = imageTypeOf(data);
  if (!type) return { status: 400, body: { error: 'image must be PNG, JPEG or WebP' } };
  if (!(await setDirectoryImage(params.id, data, type))) return { status: 404, body: { error: 'event not found' } };
  await logAudit({ actorId: user?.id ?? null, action: 'event.directory_image.set', details: { eventId: params.id } });
  return { status: 200, body: await getEvent(params.id) };
})));

// Vorschau im Event-Formular, auch solange das Event nicht veröffentlicht ist.
router.get('/events/:id/directory-image', requireAuth(requireMenu('events')(async ({ params }) => {
  const image = UUID_RE.test(params.id) ? await getDirectoryImage(params.id, { published: false }) : null;
  if (!image) return { status: 404, body: { error: 'not found' } };
  return { status: 200, isBinary: true, body: image.data, headers: { 'Content-Type': image.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } };
})));

router.delete('/events/:id/directory-image', requireAuth(requireMenu('events')(async ({ params, user }) => {
  if (!UUID_RE.test(params.id) || !(await setDirectoryImage(params.id, null, null))) return { status: 404, body: { error: 'event not found' } };
  await logAudit({ actorId: user?.id ?? null, action: 'event.directory_image.removed', details: { eventId: params.id } });
  return { status: 200, body: await getEvent(params.id) };
})));
