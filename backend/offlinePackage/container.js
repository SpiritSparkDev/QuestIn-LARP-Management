import crypto from 'node:crypto';

// .qpkg layout: MAGIC | salt(16) | iv(12) | gcm tag(16) | AES-256-GCM(scrypt(passphrase), JSON {body, sig}).
// body = JSON string of {manifest, data}; sig = HMAC-SHA256(body) keyed from ENCRYPTION_KEY,
// so a package made by someone who merely knows the passphrase is still rejected.
const MAGIC = Buffer.from('QPKG1');
const SALT = 16;
const IV = 12;
const TAG = 16;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function hmac(label, value) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is not set');
  return crypto.createHmac('sha256', crypto.createHash('sha256').update(`qpkg:${key}`).digest()).update(`${label}:${value}`).digest('hex');
}

// Deterministic, so the online side can recompute it without storing it.
export function returnToken(snapshotId) {
  return hmac('return', snapshotId);
}

export function seal({ manifest, data }, passphrase) {
  const body = JSON.stringify({ manifest, data });
  const plain = Buffer.from(JSON.stringify({ body, sig: hmac('body', body) }));
  const salt = crypto.randomBytes(SALT);
  const iv = crypto.randomBytes(IV);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

export function open(buffer, passphrase) {
  const head = MAGIC.length + SALT + IV + TAG;
  if (!Buffer.isBuffer(buffer) || buffer.length <= head || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw fail('BAD_FORMAT', 'Keine gültige Offline-Paket-Datei.');
  }
  const salt = buffer.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = buffer.subarray(MAGIC.length + SALT, MAGIC.length + SALT + IV);
  const tag = buffer.subarray(MAGIC.length + SALT + IV, head);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(buffer.subarray(head)), decipher.final()]);
  } catch {
    throw fail('BAD_PASSPHRASE', 'Falsche Passphrase oder beschädigte Datei.');
  }
  const { body, sig } = JSON.parse(plain.toString('utf8'));
  const expected = Buffer.from(hmac('body', body));
  const got = Buffer.from(String(sig));
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    throw fail('BAD_SIGNATURE', 'Signatur ungültig: Paket stammt nicht von dieser Installation oder wurde verändert.');
  }
  return JSON.parse(body);
}

export { fail };
