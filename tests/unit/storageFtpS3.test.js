import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ftpStorage } from '../../backend/storage/ftp.js';
import { s3Storage } from '../../backend/storage/s3.js';

test('ftpStorage.testConnection rejects with a real error against an unreachable host, not a hang', async () => {
  const storage = ftpStorage({ host: '127.0.0.1', port: 1, username: 'x', password: 'x', secure: false, baseDir: '/' });
  await assert.rejects(() => storage.testConnection());
});

test('s3Storage.testConnection rejects with a real error against an unreachable endpoint, not a hang', async () => {
  const storage = s3Storage({ bucket: 'test-bucket', region: 'us-east-1', endpoint: 'http://127.0.0.1:1', accessKeyId: 'x', secretAccessKey: 'x' });
  await assert.rejects(() => storage.testConnection());
});
