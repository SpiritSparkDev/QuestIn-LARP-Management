import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { query, closePool } = await import('../../backend/db.js');
const { getStorageSettings, getStorageSettingsForUse, setStorageSettings } = await import('../../backend/storageSettings/repository.js');

test('getStorageSettings defaults to local backend with no secrets set when no row exists yet', async () => {
  const settings = await getStorageSettings();
  assert.equal(settings.backend, 'local');
  assert.equal(settings.ftp.hasPassword, false);
  assert.equal(settings.s3.hasSecretKey, false);
});

test('setStorageSettings persists ftp config and encrypts the password, never returning it in plaintext', async () => {
  const saved = await setStorageSettings({
    backend: 'ftp',
    ftp: { host: 'ftp.example.com', port: 21, username: 'bot', password: 'super-secret', secure: true, baseDir: '/uploads' },
    s3: {},
  });
  assert.equal(saved.backend, 'ftp');
  assert.equal(saved.ftp.host, 'ftp.example.com');
  assert.equal(saved.ftp.hasPassword, true);
  assert.ok(!('password' in saved.ftp));
  assert.ok(!JSON.stringify(saved).includes('super-secret'));

  const forUse = await getStorageSettingsForUse();
  assert.equal(forUse.ftp.password, 'super-secret');
});

test('setStorageSettings with an omitted ftp password preserves the previously-saved password', async () => {
  await setStorageSettings({
    backend: 'ftp',
    ftp: { host: 'ftp.example.com', username: 'bot', password: 'keep-me', secure: true, baseDir: '/uploads' },
    s3: {},
  });
  const saved = await setStorageSettings({
    backend: 'ftp',
    ftp: { host: 'ftp2.example.com', username: 'bot', secure: true, baseDir: '/uploads' },
    s3: {},
  });
  assert.equal(saved.ftp.host, 'ftp2.example.com');
  assert.equal(saved.ftp.hasPassword, true);
  const forUse = await getStorageSettingsForUse();
  assert.equal(forUse.ftp.password, 'keep-me');
});

test('setStorageSettings persists s3 config and encrypts the secret key', async () => {
  const saved = await setStorageSettings({
    backend: 's3',
    ftp: {},
    s3: { bucket: 'my-bucket', region: 'eu-central-1', endpoint: null, accessKeyId: 'AKIA123', secretAccessKey: 's3-secret' },
  });
  assert.equal(saved.backend, 's3');
  assert.equal(saved.s3.bucket, 'my-bucket');
  assert.equal(saved.s3.hasSecretKey, true);
  assert.ok(!JSON.stringify(saved).includes('s3-secret'));

  const forUse = await getStorageSettingsForUse();
  assert.equal(forUse.s3.secretAccessKey, 's3-secret');
});

test.after(async () => {
  await query('DELETE FROM storage_settings');
  await closePool();
});
