// Add-on "QuestIn-Hub" (Admin → Einstellungen → Add-ons) and the domain proof
// the hub reads under /.well-known/questin-hub.
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getAppSettings } from '../appSettings/repository.js';
import { envHubConfigured } from '../hubDirectory/config.js';
import { getHubConnection } from './repository.js';
import { HubConnectionError, setEnabled, apply, verifyDomain, refresh, fetchCredentials, disconnect, PENDING_STATES } from './service.js';

const DEFAULT_HUB_URL = 'https://questin.de';

// What the settings page shows: never keys or secrets.
async function view() {
  const c = await getHubConnection();
  return {
    enabled: c.enabled,
    envConfigured: envHubConfigured(),
    status: c.status,
    statusDetail: c.statusDetail,
    hubUrl: c.hubUrl ?? process.env.HUB_DEFAULT_URL ?? DEFAULT_HUB_URL,
    orgName: c.orgName,
    contactEmail: c.contactEmail,
    keyId: c.keyId,
    applicationId: c.applicationId,
    clientId: c.clientId,
    connectedAt: c.connectedAt,
    lastCheckedAt: c.lastCheckedAt,
    instanceUrl: (await getAppSettings()).effectiveBaseUrl,
  };
}

const admin = (handler) => requireAuth(requireAdminGroup(async (ctx) => {
  try {
    return await handler(ctx);
  } catch (err) {
    if (err instanceof HubConnectionError) return { status: err.status, body: { error: err.message, connection: await view() } };
    throw err;
  }
}));

router.get('/admin/hub-connection', admin(async () => ({ status: 200, body: await view() })));

router.put('/admin/hub-connection/enabled', admin(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (typeof body?.enabled !== 'boolean') return { status: 400, body: { error: 'enabled must be true or false' } };
  await setEnabled(body.enabled, user.id);
  return { status: 200, body: await view() };
}));

router.post('/admin/hub-connection/apply', admin(async ({ req, user }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  await apply(body, user.id);
  return { status: 200, body: await view() };
}));

router.post('/admin/hub-connection/verify', admin(async ({ user }) => {
  await verifyDomain(user.id);
  return { status: 200, body: await view() };
}));

router.post('/admin/hub-connection/refresh', admin(async ({ user }) => {
  await refresh(user.id);
  return { status: 200, body: await view() };
}));

router.post('/admin/hub-connection/rotate', admin(async ({ user }) => {
  if ((await getHubConnection()).status !== 'active') return { status: 409, body: { error: 'Nur bei einer aktiven Verbindung.' } };
  await fetchCredentials(user.id);
  return { status: 200, body: await view() };
}));

router.post('/admin/hub-connection/disconnect', admin(async ({ user }) => {
  const { hubInformed } = await disconnect(user.id);
  return { status: 200, body: { ...(await view()), hubInformed } };
}));

// Domain proof: only while the add-on is on and an application waits for it.
router.get('/.well-known/questin-hub', async () => {
  const c = await getHubConnection();
  if (!c.enabled || !c.challenge || !PENDING_STATES.includes(c.status)) return { status: 404, body: { error: 'not found' } };
  return {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
    body: { applicationId: c.applicationId, challenge: c.challenge, keyId: c.keyId },
  };
});
