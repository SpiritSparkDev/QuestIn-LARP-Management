import { logger } from '../logger.js';
import { isOffline } from '../appMode.js';
import { getAppSettings } from '../appSettings/repository.js';
import { hubUrl } from './config.js';
import { saveDirectoryError, saveDirectorySuccess } from './repository.js';

const MAX_BYTES = 2_000_000;
const MAX_EVENTS = 2000;
const TIMEOUT_MS = 10_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

const text = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

// Keeps only the fields we show and drops anything malformed. Links must be
// plain http(s) URLs; the hub already checked they stay on the org's origin.
export function sanitizeDirectory(body, ownOrigin) {
  if (!body || body.version !== 1 || !Array.isArray(body.events)) throw new Error('invalid directory');
  const out = [];
  for (const e of body.events.slice(0, MAX_EVENTS)) {
    const name = text(e?.name, 200);
    const org = text(e?.org, 120);
    const start = typeof e?.startDate === 'string' && DATE_RE.test(e.startDate) ? e.startDate : null;
    const origin = originOf(e?.url);
    if (!name || !org || !start || !origin) continue;
    if (ownOrigin && origin === ownOrigin) continue;
    out.push({
      org,
      name,
      startDate: start,
      endDate: typeof e.endDate === 'string' && DATE_RE.test(e.endDate) ? e.endDate : null,
      location: text(e.location, 200),
      color: typeof e.color === 'string' && COLOR_RE.test(e.color) ? e.color : null,
      url: new URL(e.url).href,
    });
  }
  return out;
}

// Fetches the hub directory and stores it. On failure the last good list stays.
export async function refreshHubDirectory(fetchImpl = fetch) {
  const hub = hubUrl();
  if (!hub || isOffline()) return { skipped: true };
  try {
    const res = await fetchImpl(`${hub}/directory.json`, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`hub answered HTTP ${res.status}`);
    const raw = await res.text();
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('directory too large');
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error('directory is not valid JSON');
    }
    const ownOrigin = originOf((await getAppSettings()).effectiveBaseUrl);
    const events = sanitizeDirectory(body, ownOrigin);
    await saveDirectorySuccess(events);
    return { ok: true, count: events.length };
  } catch (err) {
    const message = (err.name === 'TimeoutError' ? 'hub timed out' : err.message).slice(0, 500);
    await saveDirectoryError(message);
    logger.warn('hub directory fetch failed', { error: message });
    return { ok: false, error: message };
  }
}

// Runs even without a hub yet: the add-on "QuestIn-Hub" can connect one later.
export function startHubDirectoryJob() {
  if (isOffline()) return [];
  const run = () => refreshHubDirectory().catch((err) => logger.error('hub directory job failed', { error: err.message }));
  return [setTimeout(run, 30_000).unref(), setInterval(run, 15 * 60_000).unref()];
}
