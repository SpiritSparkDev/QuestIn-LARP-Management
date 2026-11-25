// Signed requests from this instance to the QuestIn hub (add-on "QuestIn-Hub").
// The same format is implemented in the hub (questin-hub, backend/instances/signature.js);
// keep both in sync.
import crypto from 'node:crypto';

export const SIGNATURE_PREFIX = 'questin-instance-v1';
export const MAX_SKEW_SECONDS = 300;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{43}$/;

// Parses a SPKI PEM and accepts only Ed25519 keys.
export function parsePublicKey(pem) {
  if (typeof pem !== 'string' || pem.length > 1000) return null;
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

export function keyIdOf(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64url');
}

export function canonical({ method, path, timestamp, nonce, body }) {
  const hash = crypto.createHash('sha256').update(body ?? '').digest('hex');
  return `${SIGNATURE_PREFIX}\n${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${hash}`;
}

// Headers for a request signed with the instance's private key (used in tests here).
export function signRequest(privateKey, keyId, { method, path, body = '', now = Date.now() }) {
  const timestamp = String(Math.floor(now / 1000));
  const nonce = crypto.randomBytes(18).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(canonical({ method, path, timestamp, nonce, body })), privateKey).toString('base64url');
  return { 'QuestIn-Key': keyId, 'QuestIn-Timestamp': timestamp, 'QuestIn-Nonce': nonce, 'QuestIn-Signature': signature };
}

// Reads the signature headers. Returns { keyId, timestamp, nonce, signature } or null.
export function readSignatureHeaders(headers, now = Date.now()) {
  const keyId = String(headers['questin-key'] ?? '');
  const timestamp = String(headers['questin-timestamp'] ?? '');
  const nonce = String(headers['questin-nonce'] ?? '');
  const signature = String(headers['questin-signature'] ?? '');
  if (!KEY_ID_RE.test(keyId) || !/^\d{1,12}$/.test(timestamp) || !NONCE_RE.test(nonce) || !/^[A-Za-z0-9_-]{80,90}$/.test(signature)) return null;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return null;
  return { keyId, timestamp, nonce, signature };
}

export function verifySignature(publicKey, { method, path, timestamp, nonce, body, signature }) {
  try {
    return crypto.verify(null, Buffer.from(canonical({ method, path, timestamp, nonce, body })), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
