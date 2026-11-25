// Add-on "QuestIn-Hub": connects this instance to the hub without .env changes.
// Flow (hub side: questin-hub docs/plans/2026-11-25-instanz-anschluss.md):
// key pair here -> signed application -> domain proof under /.well-known/questin-hub
// -> contact confirms by mail -> hub admin approves -> we fetch the credentials
// (signed) and keep them encrypted. Nothing reaches the hub before the admin
// switches the add-on on and asks for the connection.
import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { logAudit } from '../audit/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { isOffline } from '../appMode.js';
import { envHubConfigured, hubOriginOf } from '../hubDirectory/config.js';
import { refreshHubDirectory } from '../hubDirectory/client.js';
import { keyIdOf, signRequest } from './signature.js';
import { getHubConnection, getPrivateKeyPem, updateHubConnection, WIPED } from './repository.js';

const TIMEOUT_MS = 15_000;
export const PENDING_STATES = ['verify-domain', 'confirm-email', 'review'];
const ENDED_STATES = ['rejected', 'blocked', 'disconnected'];

export class HubConnectionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const audit = (actorId, action, details = {}) => logAudit({ actorId, action: `hub.connection.${action}`, details });

// One signed call to the hub. Returns { status, body }.
async function signedCall(conn, method, path, body, fetchImpl) {
  const privateKeyPem = await getPrivateKeyPem();
  if (!privateKeyPem || !conn.keyId || !conn.hubUrl) throw new HubConnectionError('Es gibt noch keine Verbindungsanfrage.', 409);
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = { Accept: 'application/json', ...signRequest(crypto.createPrivateKey(privateKeyPem), conn.keyId, { method, path, body: text }) };
  if (text) headers['Content-Type'] = 'application/json';
  return send(fetchImpl, `${conn.hubUrl}${path}`, { method, headers, body: text || undefined });
}

async function send(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new HubConnectionError(`Der Hub ist nicht erreichbar (${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message}).`, 502);
  }
  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  return { status: res.status, body };
}

// --- Admin actions -----------------------------------------------------------------

export async function setEnabled(enabled, actorId, fetchImpl = fetch) {
  const conn = await getHubConnection();
  if (!enabled && conn.keyId) await disconnect(actorId, fetchImpl, { quiet: true });
  await updateHubConnection({ enabled });
  await audit(actorId, enabled ? 'enabled' : 'disabled');
  return getHubConnection();
}

const APPLY_ERRORS = {
  'couponCode: invalid or expired': 'Der Gutscheincode ist ungültig oder abgelaufen.',
  'instanceUrl: https URL required': 'Die Basis-URL dieser Instanz muss mit https:// beginnen (Admin → Einstellungen → Basis-URL).',
  'instanceUrl: not a public address': 'Die Basis-URL dieser Instanz ist aus dem Internet nicht erreichbar.',
  'applications are not open yet': 'Der Hub nimmt gerade noch keine Anträge an.',
  'this instance already has an open, active or blocked connection': 'Für diese Adresse gibt es am Hub schon eine offene, aktive oder gesperrte Verbindung.',
  'too many requests': 'Zu viele Anfragen. Bitte später noch einmal versuchen.',
};

// Step 2 and 3: new key pair, signed application, then domain proof.
export async function apply(input, actorId, fetchImpl = fetch) {
  if (isOffline()) throw new HubConnectionError('Im Offline-Modus nicht verfügbar.', 409);
  if (envHubConfigured()) throw new HubConnectionError('Der Hub ist schon über Umgebungsvariablen eingerichtet.', 409);
  const conn = await getHubConnection();
  if (!conn.enabled) throw new HubConnectionError('Das Add-on ist nicht aktiviert.', 409);
  if (conn.keyId && !ENDED_STATES.includes(conn.status)) throw new HubConnectionError('Es läuft schon eine Verbindung. Erst trennen, dann neu anfragen.', 409);

  const hubUrl = hubOriginOf(String(input.hubUrl ?? '').trim());
  if (!hubUrl) throw new HubConnectionError('Bitte eine gültige Hub-Adresse angeben (https://…).');
  const orgName = String(input.orgName ?? '').trim();
  const contactName = String(input.contactName ?? '').trim();
  const contactEmail = String(input.contactEmail ?? '').trim();
  if (orgName.length < 2 || orgName.length > 80) throw new HubConnectionError('Der Orga-Name braucht 2 bis 80 Zeichen.');
  if (contactName.length < 2 || contactName.length > 120) throw new HubConnectionError('Bitte eine Ansprechperson angeben.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new HubConnectionError('Bitte eine gültige Kontaktmail angeben.');
  const instanceUrl = (await getAppSettings()).effectiveBaseUrl;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = keyIdOf(publicKey);
  const body = {
    instanceUrl, orgName, contactName, contactEmail, publicKey: publicKeyPem,
    couponCode: String(input.couponCode ?? '').trim() || undefined, message: String(input.message ?? '').trim() || undefined,
  };
  const text = JSON.stringify(body);
  const path = '/api/v1/instances/applications';
  const res = await send(fetchImpl, `${hubUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...signRequest(privateKey, keyId, { method: 'POST', path, body: text }) }, body: text,
  });
  if (res.status !== 201 || !res.body?.applicationId || !res.body?.challenge) {
    const error = res.body?.error;
    throw new HubConnectionError(APPLY_ERRORS[error] ?? `Der Hub hat die Anfrage abgelehnt (${error ?? `HTTP ${res.status}`}).`, res.status === 429 ? 429 : 400);
  }
  await updateHubConnection({
    ...WIPED, hubUrl, status: 'verify-domain', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKeyPem,
    keyId, applicationId: res.body.applicationId, challenge: res.body.challenge, orgName, contactEmail,
  });
  await audit(actorId, 'applied', { hubUrl, instanceUrl, applicationId: res.body.applicationId, keyId });
  return verifyDomain(actorId, fetchImpl);
}

// Step 3: asks the hub to read /.well-known/questin-hub (again).
export async function verifyDomain(actorId, fetchImpl = fetch) {
  const conn = await getHubConnection();
  const res = await signedCall(conn, 'POST', '/api/v1/instances/verify', undefined, fetchImpl);
  const status = res.body?.status;
  if (status && status !== conn.status) await updateHubConnection({ status, statusDetail: res.body?.error ?? null });
  else if (res.body?.error) await updateHubConnection({ statusDetail: res.body.error });
  await audit(actorId, res.status === 200 ? 'domain_verified' : 'domain_failed', res.body?.error ? { error: res.body.error } : {});
  return getHubConnection();
}

// Status from the hub; after approval the credentials are fetched, when the
// hub ends the connection they are deleted here.
export async function refresh(actorId = null, fetchImpl = fetch) {
  let conn = await getHubConnection();
  if (!conn.enabled || !conn.keyId || isOffline()) return conn;
  const res = await signedCall(conn, 'GET', '/api/v1/instances/status', undefined, fetchImpl);
  if (res.status === 401) {
    await updateHubConnection({ status: 'disconnected', statusDetail: 'Der Hub kennt den Schlüssel dieser Instanz nicht mehr.', clientId: null, clientSecret: null, issuer: null });
    return getHubConnection();
  }
  if (res.status !== 200 || !res.body?.status) throw new HubConnectionError(`Der Hub hat nicht wie erwartet geantwortet (HTTP ${res.status}).`, 502);
  const status = res.body.status;
  const detail = res.body.note ?? res.body.domainError ?? null;
  if (ENDED_STATES.includes(status)) {
    if (conn.status !== status) await audit(actorId, `ended_${status}`, detail ? { note: detail } : {});
    await updateHubConnection({ status, statusDetail: detail, clientId: null, clientSecret: null, issuer: null, lastCheckedAt: new Date() });
    return getHubConnection();
  }
  await updateHubConnection({ status, statusDetail: detail, lastCheckedAt: new Date() });
  conn = await getHubConnection();
  if (status === 'active' && !conn.hasCredentials) return fetchCredentials(actorId, fetchImpl);
  return conn;
}

// Step 6, also secret rotation: every call gets a new secret from the hub.
export async function fetchCredentials(actorId = null, fetchImpl = fetch) {
  const conn = await getHubConnection();
  const res = await signedCall(conn, 'POST', '/api/v1/instances/credentials', undefined, fetchImpl);
  if (res.status !== 200) throw new HubConnectionError(`Der Hub gibt noch keine Zugangsdaten heraus (${res.body?.status ?? `HTTP ${res.status}`}).`, 409);
  const { hubUrl, issuer, clientId, clientSecret } = res.body ?? {};
  if (!hubOriginOf(String(issuer ?? '')) || !/^qi_[0-9a-f]{16}$/.test(String(clientId)) || typeof clientSecret !== 'string' || clientSecret.length < 32) {
    throw new HubConnectionError('Der Hub hat unvollständige Zugangsdaten geschickt.', 502);
  }
  const rotated = conn.hasCredentials;
  await updateHubConnection({
    status: 'active', statusDetail: null, hubUrl: hubOriginOf(hubUrl) ?? conn.hubUrl, issuer, clientId, clientSecret,
    connectedAt: conn.connectedAt ?? new Date(), lastCheckedAt: new Date(),
  });
  await audit(actorId, rotated ? 'secret_rotated' : 'connected', { clientId });
  if (!rotated) refreshHubDirectory().catch((err) => logger.warn('hub directory refresh after connect failed', { error: err.message }));
  return getHubConnection();
}

// Informs the hub (best effort) and deletes keys and credentials here.
export async function disconnect(actorId, fetchImpl = fetch, { quiet = false } = {}) {
  const conn = await getHubConnection();
  let hubInformed = false;
  if (conn.keyId && !['disconnected', 'off'].includes(conn.status)) {
    try {
      const res = await signedCall(conn, 'POST', '/api/v1/instances/disconnect', undefined, fetchImpl);
      hubInformed = res.status === 200;
    } catch (err) {
      if (!quiet) logger.warn('hub disconnect call failed', { error: err.message });
    }
  }
  await updateHubConnection({ ...WIPED });
  await audit(actorId, 'disconnected', { hubInformed });
  return { connection: await getHubConnection(), hubInformed };
}

// Webhook "instance.revoked" (signature already checked by the caller).
export async function revokedByHub(reason) {
  await updateHubConnection({ status: 'blocked', statusDetail: reason ?? null, clientId: null, clientSecret: null, issuer: null });
  await audit(null, 'ended_blocked', reason ? { note: reason } : {});
}

// --- Background job ------------------------------------------------------------------

export function startHubConnectionJob() {
  if (isOffline()) return [];
  const run = async () => {
    try {
      const conn = await getHubConnection();
      if (conn.enabled && conn.keyId && (PENDING_STATES.includes(conn.status) || conn.status === 'active' || conn.status === 'blocked')) await refresh();
    } catch (err) {
      logger.warn('hub connection check failed', { error: err.message });
    }
  };
  return [setTimeout(run, 45_000).unref(), setInterval(run, 10 * 60_000).unref()];
}
