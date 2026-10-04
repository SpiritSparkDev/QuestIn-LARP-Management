import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { localStorage } from '../../backend/storage/local.js';

test('local storage roundtrips upload/download/remove', async () => {
  const dir = path.join(os.tmpdir(), `storage-local-test-${crypto.randomUUID()}`);
  const storage = localStorage({ uploadsDir: dir });
  const id = crypto.randomUUID();
  const buffer = Buffer.from('hello storage');

  await storage.upload(id, buffer);
  const downloaded = await storage.download(id);
  assert.deepEqual(downloaded, buffer);

  await storage.remove(id);
  await assert.rejects(() => storage.download(id));

  await fs.rm(dir, { recursive: true, force: true });
});

test('local storage testConnection creates the directory if missing', async () => {
  const dir = path.join(os.tmpdir(), `storage-local-test-${crypto.randomUUID()}`);
  const storage = localStorage({ uploadsDir: dir });
  await storage.testConnection();
  const stat = await fs.stat(dir);
  assert.ok(stat.isDirectory());
  await fs.rm(dir, { recursive: true, force: true });
});

test('local storage supports nested per-character keys and removes the emptied folder', async () => {
  const dir = path.join(os.tmpdir(), `storage-local-test-${crypto.randomUUID()}`);
  const storage = localStorage({ uploadsDir: dir });
  const characterId = crypto.randomUUID();
  const keyA = `${characterId}/${crypto.randomUUID()}`;
  const keyB = `${characterId}/${crypto.randomUUID()}`;

  await storage.upload(keyA, Buffer.from('a'));
  await storage.upload(keyB, Buffer.from('b'));
  assert.deepEqual(await storage.download(keyA), Buffer.from('a'));

  await storage.remove(keyA);
  assert.ok((await fs.stat(path.join(dir, characterId))).isDirectory(), 'folder stays while it still holds a file');
  await storage.remove(keyB);
  await assert.rejects(() => fs.stat(path.join(dir, characterId)), 'folder is removed once empty');

  await fs.rm(dir, { recursive: true, force: true });
});
