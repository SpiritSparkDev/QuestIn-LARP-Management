import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { encryptField, decryptField } = await import('../../backend/crypto/fieldCrypto.js');

test('encrypts and decrypts a round trip', () => {
  const ciphertext = encryptField('Musterstraße 1, 12345 Musterstadt');
  assert.ok(Buffer.isBuffer(ciphertext));
  assert.equal(decryptField(ciphertext), 'Musterstraße 1, 12345 Musterstadt');
});

test('produces a different ciphertext each call (random IV)', () => {
  const a = encryptField('same input');
  const b = encryptField('same input');
  assert.notDeepEqual(a, b);
});

test('null passes through unchanged', () => {
  assert.equal(encryptField(null), null);
  assert.equal(decryptField(null), null);
});

test('a tampered ciphertext fails to decrypt', () => {
  const ciphertext = encryptField('secret');
  const tampered = Buffer.from(ciphertext);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptField(tampered));
});
