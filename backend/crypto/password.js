import crypto from 'node:crypto';

const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return derivedKey.length === expected.length && crypto.timingSafeEqual(derivedKey, expected);
}
