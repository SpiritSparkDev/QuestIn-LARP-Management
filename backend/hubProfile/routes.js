import crypto from 'node:crypto';
import { router } from '../routes.js';
import { query } from '../db.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody, readRawBody } from '../httpBody.js';
import { hubConfig } from '../auth/hubLogin.js';
import { logAudit } from '../audit/repository.js';
import { logger } from '../logger.js';
import { HUB_PROFILE_FIELDS, getMapping, setMapping, profileOffer, applyProfile, deleteSnapshots } from './repository.js';

const WEBHOOK_MAX_SKEW_SECONDS = 5 * 60;

// --- Admin: Zuordnung Hub-Schlüssel -> Kontofeld ----------------------------

router.get('/admin/hub-profile-mapping', requireAuth(requireAdminGroup(async () => ({
  status: 200,
  body: { hubFields: HUB_PROFILE_FIELDS, mapping: await getMapping() },
}))));

router.put('/admin/hub-profile-mapping', requireAuth(requireAdminGroup(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null || typeof body.mapping !== 'object') return { status: 400, body: { error: 'mapping is required' } };
  const result = await setMapping(body.mapping);
  if (result.error) return { status: 400, body: { error: result.error } };
  await logAudit({ actorId: user.id, action: 'hub.mapping_changed', details: { mapping: result.mapping } });
  return { status: 200, body: { mapping: result.mapping } };
})));

// --- Person: Abweichungen ansehen und übernehmen -----------------------------

router.get('/hub/profile', requireAuth(async ({ user }) => {
  const { rows } = await query("SELECT 1 FROM oauth_accounts WHERE user_id = $1 AND provider = 'hub'", [user.id]);
  const available = Boolean(hubConfig()) && rows.length > 0;
  if (!available) return { status: 200, body: { available: false } };
  return { status: 200, body: { available: true, ...(await profileOffer(user.id)) } };
}));

router.post('/hub/profile/apply', requireAuth(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null || !Array.isArray(body.keys)) return { status: 400, body: { error: 'keys is required' } };
  return { status: 200, body: await applyProfile(user.id, body.keys.filter((k) => typeof k === 'string')) };
}));

// --- Webhook vom Hub (consent.revoked, account.deleted) ---------------------

export function verifyHubSignature(secret, timestamp, rawBody, signature, now = Date.now()) {
  if (!/^\d+$/.test(timestamp ?? '') || !/^[0-9a-f]{64}$/.test(signature ?? '')) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_MAX_SKEW_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

router.post('/api/hub/webhook', async ({ req, requestId }) => {
  const config = hubConfig();
  if (!config) return { status: 404, body: { error: 'not found' } };
  const raw = await readRawBody(req, 100_000);
  if (raw === null) return { status: 400, body: { error: 'invalid body' } };
  const text = raw.toString('utf8');
  if (!verifyHubSignature(config.clientSecret, req.headers['x-questin-timestamp'], text, req.headers['x-questin-signature'])) {
    logger.warn('hub webhook with invalid signature', { requestId });
    return { status: 401, body: { error: 'invalid signature' } };
  }
  let event;
  try { event = JSON.parse(text); } catch { return { status: 400, body: { error: 'invalid JSON' } }; }

  const { rows } = await query("SELECT user_id FROM oauth_accounts WHERE provider = 'hub' AND provider_user_id = $1", [String(event.sub ?? '')]);
  const userId = rows[0]?.user_id;
  // Unknown sub: nothing stored here, acknowledge so the hub stops retrying.
  if (!userId) return { status: 200, body: { ok: true } };

  if (event.event === 'consent.revoked' && Array.isArray(event.categories)) {
    await deleteSnapshots(userId, event.categories.map(String));
    await logAudit({ actorId: null, action: 'hub.consent_revoked', subjectUserId: userId, details: { categories: event.categories } });
  } else if (event.event === 'account.deleted') {
    // Hub-Kopie sofort weg, Verknüpfung lösen. Das lokale Konto (Anmeldungen,
    // Zahlungen, selbst übernommene Felder) folgt den Fristen dieser Instanz.
    await deleteSnapshots(userId);
    await query("DELETE FROM oauth_accounts WHERE user_id = $1 AND provider = 'hub'", [userId]);
    await logAudit({ actorId: null, action: 'hub.account_deleted', subjectUserId: userId, details: {} });
  }
  return { status: 200, body: { ok: true } };
});
