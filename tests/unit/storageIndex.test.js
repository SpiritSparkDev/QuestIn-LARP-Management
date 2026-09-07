import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStorage } from '../../backend/storage/index.js';

test('getStorage returns an object with upload/download/remove/testConnection for each backend', () => {
  for (const backend of ['local', 'ftp', 's3']) {
    const storage = getStorage(backend, { ftp: {}, s3: {} });
    assert.equal(typeof storage.upload, 'function');
    assert.equal(typeof storage.download, 'function');
    assert.equal(typeof storage.remove, 'function');
    assert.equal(typeof storage.testConnection, 'function');
  }
});

test('getStorage defaults to local for an unknown backend key', () => {
  const storage = getStorage('unknown', {});
  assert.equal(typeof storage.upload, 'function');
});
