// "Charakter aus QuestIn-Konto übernehmen" (hub plan Hub-Ausbau, Phase 14):
// reads the person's Charakter-Mappe from the hub server side
// (GET /api/v1/characters?sub=, HTTP Basic with this instance's client) and
// returns them with a suggestion for this instance's character form. The
// person checks the prefilled form and saves it; nothing is synced later.
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { isOffline } from '../appMode.js';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { hubConfig } from '../hubDirectory/config.js';
import { getScCharacterSchema } from '../scSchema/repository.js';
import { mapHubCharacter } from './mapping.js';

const TIMEOUT_MS = 5_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

async function hubSub(userId) {
  const { rows } = await query("SELECT provider_user_id FROM oauth_accounts WHERE user_id = $1 AND provider = 'hub'", [userId]);
  return rows[0]?.provider_user_id ?? null;
}

// { state: 'unavailable' | 'not-linked' | 'no-consent' | 'error' | 'ok', characters? }
export async function fetchHubCharacters(userId, fetchImpl = fetch) {
  const config = hubConfig();
  if (!config || isOffline()) return { state: 'unavailable' };
  const sub = await hubSub(userId);
  if (!sub) return { state: 'not-linked' };
  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64');
  try {
    const url = new URL('/api/v1/characters', config.issuer);
    url.searchParams.set('sub', sub);
    const res = await fetchImpl(url, { headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 403) return { state: 'no-consent' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const characters = (Array.isArray(body?.characters) ? body.characters : []).filter((c) => typeof c?.name === 'string' && c.name.trim()).map((c) => ({
      id: str(c.id, 64),
      name: str(c.name, 120),
      people: str(c.people, 120),
      profession: str(c.profession, 120),
      summary: str(c.summary, 500),
      background: str(c.background, 20000),
      image: c.image && IMAGE_TYPES.has(c.image.type) && typeof c.image.base64 === 'string' && c.image.base64.length <= 700_000
        ? { type: c.image.type, base64: c.image.base64 } : null,
    }));
    return { state: 'ok', characters };
  } catch (err) {
    logger.warn('hub characters unavailable', { error: err.name === 'TimeoutError' ? 'timeout' : err.message });
    return { state: 'error' };
  }
}

router.get('/hub-characters', requireAuth(async ({ user }) => {
  const result = await fetchHubCharacters(user.id);
  if (result.state !== 'ok') return { status: 200, body: { state: result.state, characters: [] } };
  const schema = await getScCharacterSchema();
  return {
    status: 200,
    body: {
      state: 'ok',
      characters: result.characters.map((c) => ({ ...c, suggestion: mapHubCharacter(c, schema) })),
    },
  };
}));
