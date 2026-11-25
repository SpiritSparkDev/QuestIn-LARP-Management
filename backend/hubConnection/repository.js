// State of the add-on "QuestIn-Hub" (one row in hub_connection).
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
import { setStoredHubConnection } from '../hubDirectory/config.js';
import { logger } from '../logger.js';

const COLUMNS = {
  enabled: 'enabled', hubUrl: 'hub_url', status: 'status', statusDetail: 'status_detail', publicKey: 'public_key',
  keyId: 'key_id', applicationId: 'application_id', challenge: 'challenge', orgName: 'org_name', contactEmail: 'contact_email',
  clientId: 'client_id', issuer: 'issuer', connectedAt: 'connected_at', lastCheckedAt: 'last_checked_at',
};

function fromRow(r) {
  if (!r) return null;
  const out = {};
  for (const [key, column] of Object.entries(COLUMNS)) out[key] = r[column];
  out.hasPrivateKey = r.private_key_enc != null;
  out.hasCredentials = r.client_id != null && r.client_secret_enc != null;
  return out;
}

export async function getHubConnection() {
  const { rows } = await query('SELECT * FROM hub_connection WHERE id');
  return fromRow(rows[0]) ?? fromRow({ enabled: false, status: 'off' });
}

export async function getPrivateKeyPem() {
  const { rows } = await query('SELECT private_key_enc FROM hub_connection WHERE id');
  return rows[0]?.private_key_enc ? decryptField(rows[0].private_key_enc) : null;
}

// fields: keys of COLUMNS, plus privateKeyPem / clientSecret (stored encrypted, null clears).
export async function updateHubConnection(fields) {
  const sets = [];
  const values = [];
  const push = (column, value) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  for (const [key, column] of Object.entries(COLUMNS)) if (fields[key] !== undefined) push(column, fields[key]);
  if (fields.privateKeyPem !== undefined) push('private_key_enc', fields.privateKeyPem == null ? null : encryptField(fields.privateKeyPem));
  if (fields.clientSecret !== undefined) push('client_secret_enc', fields.clientSecret == null ? null : encryptField(fields.clientSecret));
  if (!sets.length) return getHubConnection();
  await query(
    `INSERT INTO hub_connection (id) VALUES (true) ON CONFLICT (id) DO NOTHING`
  );
  await query(`UPDATE hub_connection SET ${sets.join(', ')}, updated_at = now() WHERE id`, values);
  await loadHubConnection();
  return getHubConnection();
}

// Everything the hub gave us or we made for it goes; enabled stays as it is.
export const WIPED = {
  status: 'off', statusDetail: null, privateKeyPem: null, publicKey: null, keyId: null, applicationId: null, challenge: null,
  clientId: null, clientSecret: null, issuer: null, connectedAt: null,
};

// Pushes the active credentials into hubDirectory/config.js (startup and after each change).
export async function loadHubConnection() {
  try {
    const { rows } = await query('SELECT * FROM hub_connection WHERE id');
    const r = rows[0];
    if (!r || !r.enabled || r.status !== 'active' || !r.client_secret_enc) {
      setStoredHubConnection(null);
      return;
    }
    setStoredHubConnection({ hubUrl: r.hub_url, issuer: r.issuer, clientId: r.client_id, clientSecret: decryptField(r.client_secret_enc) });
  } catch (err) {
    setStoredHubConnection(null);
    logger.error('loading the hub connection failed', { error: err.message });
  }
}
