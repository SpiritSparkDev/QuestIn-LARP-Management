# Datei-Storage extern (FTP/S3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin configure FTP or S3 as the storage backend for character-file uploads (instead of local disk), with per-file backend tracking so existing files keep working after a switch, a usage-by-backend bar chart, and an on-demand migration to move existing files onto the currently active backend.

**Architecture:** A new `backend/storage/` module exposes one `upload/download/remove/testConnection` interface per backend (local/ftp/s3), dispatched via `getStorage(backendName, settings)`. `character_files` gets a `storage_backend` column stamped at upload time, so reads/deletes always use the backend a file actually lives on, independent of whichever backend is currently active. A new admin-only `storage_settings` table + `/admin/settings/storage*` routes manage configuration, connection testing, usage reporting, and migration — mirroring the existing `smtp_settings`/SMTP-routes pattern exactly.

**Tech Stack:** Node.js (`node:test` for tests), PostgreSQL, `basic-ftp` (new dependency, FTP/FTPS client), `@aws-sdk/client-s3` (new dependency, S3 client).

**Spec:** `docs/superpowers/specs/2026-09-07-datei-storage-extern.md`

## Global Constraints

- Only secrets are encrypted at rest (`ftp_password_enc`, `s3_secret_access_key_enc` via `backend/crypto/fieldCrypto.js`'s `encryptField`/`decryptField`) — host/port/user/bucket/region/endpoint stay plaintext, matching every existing settings table in this codebase.
- Every backend uses the UUID-only filename/key scheme already established by `character_files.id` — never a client-controlled path segment, on any backend.
- Downloads are always proxied through the app for every backend (no S3 presigned-URL redirect).
- FTP always attempts FTPS (`secure: true`) unless the admin explicitly unchecks it in the settings form.
- Migration runs synchronously in one HTTP request, continues past a single file's failure, and returns a full `{migrated, failed}` report at the end — no background job system.
- A file's own `storage_backend` column, not whatever backend is currently active, controls where it is read from/deleted from.
- The plan's last task's last step must run the full `npm test` suite.

---

### Task 1: Datenmodell — Migration + `storageSettings`-Repository

**Files:**
- Create: `db/migrations/026_storage_backend.sql`
- Create: `backend/storageSettings/repository.js`
- Test: `tests/unit/storageSettingsRepository.test.js`

**Interfaces:**
- Produces: `getStorageSettings(): Promise<{backend: 'local'|'ftp'|'s3', ftp: {host, port, username, hasPassword, secure, baseDir}, s3: {bucket, region, endpoint, accessKeyId, hasSecretKey}}>`
- Produces: `getStorageSettingsForUse(): Promise<{backend, ftp: {host, port, username, password, secure, baseDir}, s3: {bucket, region, endpoint, accessKeyId, secretAccessKey}}>` (decrypted secrets, for actual storage operations, never exposed over HTTP)
- Produces: `setStorageSettings({backend, ftp, s3}): Promise<same shape as getStorageSettings()>` — `ftp.password`/`s3.secretAccessKey` optional; omitted/falsy leaves the previously-saved secret untouched (`COALESCE` pattern).

- [ ] **Step 1: Create the migration**

```sql
CREATE TABLE storage_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backend text NOT NULL DEFAULT 'local' CHECK (backend IN ('local', 'ftp', 's3')),
  ftp_host text,
  ftp_port integer,
  ftp_username text,
  ftp_password_enc bytea,
  ftp_secure boolean NOT NULL DEFAULT true,
  ftp_base_dir text,
  s3_bucket text,
  s3_region text,
  s3_endpoint text,
  s3_access_key_id text,
  s3_secret_access_key_enc bytea
);

ALTER TABLE character_files ADD COLUMN storage_backend text NOT NULL DEFAULT 'local'
  CHECK (storage_backend IN ('local', 'ftp', 's3'));
```

Save as `db/migrations/026_storage_backend.sql`.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/storageSettingsRepository.test.js`:

```javascript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/unit/storageSettingsRepository.test.js`
Expected: FAIL — `Cannot find module '../../backend/storageSettings/repository.js'` (file doesn't exist yet).

- [ ] **Step 4: Implement the repository**

Create `backend/storageSettings/repository.js`:

```javascript
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

export async function getStorageSettings() {
  const { rows } = await query(
    `SELECT backend, ftp_host, ftp_port, ftp_username, ftp_password_enc IS NOT NULL AS has_ftp_password,
            ftp_secure, ftp_base_dir, s3_bucket, s3_region, s3_endpoint, s3_access_key_id,
            s3_secret_access_key_enc IS NOT NULL AS has_s3_secret_key
     FROM storage_settings LIMIT 1`
  );
  if (rows.length === 0) {
    return {
      backend: 'local',
      ftp: { host: null, port: null, username: null, hasPassword: false, secure: true, baseDir: null },
      s3: { bucket: null, region: null, endpoint: null, accessKeyId: null, hasSecretKey: false },
    };
  }
  const r = rows[0];
  return {
    backend: r.backend,
    ftp: { host: r.ftp_host, port: r.ftp_port, username: r.ftp_username, hasPassword: r.has_ftp_password, secure: r.ftp_secure, baseDir: r.ftp_base_dir },
    s3: { bucket: r.s3_bucket, region: r.s3_region, endpoint: r.s3_endpoint, accessKeyId: r.s3_access_key_id, hasSecretKey: r.has_s3_secret_key },
  };
}

export async function getStorageSettingsForUse() {
  const { rows } = await query(
    `SELECT backend, ftp_host, ftp_port, ftp_username, ftp_password_enc, ftp_secure, ftp_base_dir,
            s3_bucket, s3_region, s3_endpoint, s3_access_key_id, s3_secret_access_key_enc
     FROM storage_settings LIMIT 1`
  );
  if (rows.length === 0) {
    return { backend: 'local', ftp: {}, s3: {} };
  }
  const r = rows[0];
  return {
    backend: r.backend,
    ftp: { host: r.ftp_host, port: r.ftp_port, username: r.ftp_username, password: decryptField(r.ftp_password_enc), secure: r.ftp_secure, baseDir: r.ftp_base_dir },
    s3: { bucket: r.s3_bucket, region: r.s3_region, endpoint: r.s3_endpoint, accessKeyId: r.s3_access_key_id, secretAccessKey: decryptField(r.s3_secret_access_key_enc) },
  };
}

export async function setStorageSettings({ backend, ftp, s3 }) {
  const id = await ensureSettingsRow();
  const ftpPasswordEnc = ftp?.password ? encryptField(ftp.password) : null;
  const s3SecretEnc = s3?.secretAccessKey ? encryptField(s3.secretAccessKey) : null;
  await query(
    `UPDATE storage_settings SET
       backend = $2,
       ftp_host = $3, ftp_port = $4, ftp_username = $5,
       ftp_password_enc = COALESCE($6, ftp_password_enc),
       ftp_secure = $7, ftp_base_dir = $8,
       s3_bucket = $9, s3_region = $10, s3_endpoint = $11, s3_access_key_id = $12,
       s3_secret_access_key_enc = COALESCE($13, s3_secret_access_key_enc)
     WHERE id = $1`,
    [
      id, backend,
      ftp?.host ?? null, ftp?.port ?? null, ftp?.username ?? null, ftpPasswordEnc,
      ftp?.secure ?? true, ftp?.baseDir ?? null,
      s3?.bucket ?? null, s3?.region ?? null, s3?.endpoint ?? null, s3?.accessKeyId ?? null, s3SecretEnc,
    ]
  );
  return getStorageSettings();
}

async function ensureSettingsRow() {
  const { rows } = await query('SELECT id FROM storage_settings LIMIT 1');
  if (rows.length > 0) return rows[0].id;
  const { rows: inserted } = await query('INSERT INTO storage_settings DEFAULT VALUES RETURNING id');
  return inserted[0].id;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/unit/storageSettingsRepository.test.js`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Commit**

```bash
git add db/migrations/026_storage_backend.sql backend/storageSettings/repository.js tests/unit/storageSettingsRepository.test.js
git commit -m "feat: add storage_settings table and repository for FTP/S3 config"
```

---

### Task 2: Storage-Abstraktion (`backend/storage/`)

**Files:**
- Create: `backend/storage/local.js`
- Create: `backend/storage/ftp.js`
- Create: `backend/storage/s3.js`
- Create: `backend/storage/index.js`
- Test: `tests/unit/storageLocal.test.js`
- Test: `tests/unit/storageFtpS3.test.js`
- Test: `tests/unit/storageIndex.test.js`
- Modify: `package.json` (add `basic-ftp`, `@aws-sdk/client-s3`)

**Interfaces:**
- Consumes: nothing from Task 1 directly (this module takes settings shapes as plain objects, decoupled from the repository).
- Produces: `localStorage(config): {upload(id, buffer), download(id): Promise<Buffer>, remove(id), testConnection()}` where `config` is `{uploadsDir?}`.
- Produces: `ftpStorage(config): {upload, download, remove, testConnection}` where `config` is `{host, port, username, password, secure, baseDir}`.
- Produces: `s3Storage(config): {upload, download, remove, testConnection}` where `config` is `{bucket, region, endpoint, accessKeyId, secretAccessKey}`.
- Produces: `getStorage(backendName: 'local'|'ftp'|'s3', settings: {ftp, s3}): {upload, download, remove, testConnection}` — dispatches to the matching module above (`settings.ftp`/`settings.s3` are the shapes `getStorageSettingsForUse()` returns; an optional `settings.local` feeds `localStorage`, defaulting to `{}`).

- [ ] **Step 1: Install the new dependencies**

Run: `npm install basic-ftp @aws-sdk/client-s3`
Expected: `package.json`'s `dependencies` gains `basic-ftp` and `@aws-sdk/client-s3`, `package-lock.json` updates.

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/storageLocal.test.js`:

```javascript
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
```

Create `tests/unit/storageFtpS3.test.js` (no live FTP/S3 server needed — proves the error path rejects quickly with a real error instead of hanging or crashing, same rigor as this project's SMTP-test-mail precedent):

```javascript
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
```

Create `tests/unit/storageIndex.test.js`:

```javascript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/unit/storageLocal.test.js tests/unit/storageFtpS3.test.js tests/unit/storageIndex.test.js`
Expected: FAIL — `Cannot find module '../../backend/storage/local.js'` (and siblings; none of the four files exist yet).

- [ ] **Step 4: Implement `backend/storage/local.js`**

```javascript
import fs from 'node:fs/promises';
import path from 'node:path';

export function localStorage({ uploadsDir } = {}) {
  const dir = uploadsDir || process.env.UPLOADS_DIR || './uploads';
  return {
    async upload(id, buffer) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, id), buffer);
    },
    async download(id) {
      return fs.readFile(path.join(dir, id));
    },
    async remove(id) {
      await fs.unlink(path.join(dir, id));
    },
    async testConnection() {
      await fs.mkdir(dir, { recursive: true });
    },
  };
}
```

- [ ] **Step 5: Implement `backend/storage/ftp.js`**

```javascript
import { Client } from 'basic-ftp';
import { Readable, PassThrough } from 'node:stream';

async function withClient(config, fn) {
  const client = new Client();
  try {
    await client.access({
      host: config.host,
      port: config.port || 21,
      user: config.username,
      password: config.password,
      secure: config.secure !== false,
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

function remotePath(baseDir, id) {
  return `${(baseDir || '').replace(/\/$/, '')}/${id}`;
}

export function ftpStorage(config) {
  return {
    async upload(id, buffer) {
      await withClient(config, (client) => client.uploadFrom(Readable.from(buffer), remotePath(config.baseDir, id)));
    },
    async download(id) {
      return withClient(config, async (client) => {
        const chunks = [];
        const sink = new PassThrough();
        sink.on('data', (chunk) => chunks.push(chunk));
        await client.downloadTo(sink, remotePath(config.baseDir, id));
        return Buffer.concat(chunks);
      });
    },
    async remove(id) {
      await withClient(config, (client) => client.remove(remotePath(config.baseDir, id)));
    },
    async testConnection() {
      await withClient(config, (client) => client.list(config.baseDir || '/'));
    },
  };
}
```

- [ ] **Step 6: Implement `backend/storage/s3.js`**

```javascript
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

export function s3Storage(config) {
  const client = new S3Client({
    region: config.region || 'us-east-1',
    endpoint: config.endpoint || undefined,
    forcePathStyle: !!config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  return {
    async upload(id, buffer) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: id, Body: buffer }));
    },
    async download(id) {
      const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: id }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
    async remove(id) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: id }));
    },
    async testConnection() {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    },
  };
}
```

- [ ] **Step 7: Implement `backend/storage/index.js`**

```javascript
import { localStorage } from './local.js';
import { ftpStorage } from './ftp.js';
import { s3Storage } from './s3.js';

export function getStorage(backend, settings) {
  if (backend === 'ftp') return ftpStorage(settings.ftp);
  if (backend === 's3') return s3Storage(settings.s3);
  return localStorage(settings.local ?? {});
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test tests/unit/storageLocal.test.js tests/unit/storageFtpS3.test.js tests/unit/storageIndex.test.js`
Expected: PASS (6 tests total).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json backend/storage/ tests/unit/storageLocal.test.js tests/unit/storageFtpS3.test.js tests/unit/storageIndex.test.js
git commit -m "feat: add local/ftp/s3 storage backend modules"
```

---

### Task 3: `characterFiles` auf die Storage-Abstraktion umstellen

**Files:**
- Modify: `backend/characterFiles/repository.js`
- Modify: `backend/characterFiles/routes.js`
- Modify: `tests/integration/characterFiles.test.js`

**Interfaces:**
- Consumes: `getStorage(backend, settings)` from Task 2 (`backend/storage/index.js`), `getStorageSettingsForUse()` from Task 1 (`backend/storageSettings/repository.js`).
- Produces: `createCharacterFile({..., storageBackend})` (repository, new required field), every `character_files` row now carries `storage_backend` in its returned shape.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/characterFiles.test.js`, right before the final `test.after(...)` block:

```javascript
test('upload against a broken external backend surfaces 502, not silently succeeding or 500', async () => {
  await withTestServer(async (port) => {
    await query(
      `INSERT INTO storage_settings (backend, s3_bucket, s3_region, s3_endpoint, s3_access_key_id)
       VALUES ('s3', 'nonexistent-bucket', 'us-east-1', 'http://127.0.0.1:1', 'x')`
    );
    try {
      const owner = await makeUserAndSession('sc');
      const characterId = await makeCharacter(owner.userId);
      const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
        body: JSON.stringify({ kind: 'image', filename: 'x.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, gdprConsent: true }),
      });
      assert.equal(uploadRes.status, 502);
    } finally {
      await query('DELETE FROM storage_settings');
    }
  });
});

test('a file already stored on "local" is still served correctly even while a different backend is active', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('sc');
    const characterId = await makeCharacter(owner.userId);
    const uploadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ kind: 'image', filename: 'x.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64, gdprConsent: true }),
    });
    const { id: fileId } = await uploadRes.json();

    // Switch the active backend to something unreachable AFTER the file was
    // already uploaded to 'local' -- the file's own stamped storage_backend
    // must still control where it's read from, not whatever is active now.
    await query(
      `INSERT INTO storage_settings (backend, s3_bucket, s3_region, s3_endpoint, s3_access_key_id)
       VALUES ('s3', 'nonexistent-bucket', 'us-east-1', 'http://127.0.0.1:1', 'x')`
    );
    try {
      const downloadRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { headers: { Cookie: owner.cookie } });
      assert.equal(downloadRes.status, 200);
    } finally {
      await query('DELETE FROM storage_settings');
    }
  });
});

test('delete surfaces 502 if removal from an external backend fails, even though the DB row is already gone', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('sc');
    const characterId = await makeCharacter(owner.userId);
    await query(
      `INSERT INTO storage_settings (backend, s3_bucket, s3_region, s3_endpoint, s3_access_key_id)
       VALUES ('s3', 'nonexistent-bucket', 'us-east-1', 'http://127.0.0.1:1', 'x')`
    );
    try {
      const { rows } = await query(
        `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, storage_backend)
         VALUES (gen_random_uuid(), $1, $2, 'image', 'x.png', 'image/png', 10, 's3') RETURNING id`,
        [characterId, owner.userId]
      );
      const fileId = rows[0].id;

      const deleteRes = await fetch(`http://localhost:${port}/characters/${characterId}/files/${fileId}`, { method: 'DELETE', headers: { Cookie: owner.cookie } });
      assert.equal(deleteRes.status, 502);
    } finally {
      await query('DELETE FROM storage_settings');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/characterFiles.test.js`
Expected: FAIL — the first new test expects 502 but gets 201 (uploads still always go to local disk, `storage_settings` isn't read yet).

- [ ] **Step 3: Update `backend/characterFiles/repository.js`**

Change the `SELECT_COLUMNS` constant and `createCharacterFile`:

```javascript
import { query } from '../db.js';

const SELECT_COLUMNS = 'id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, is_public, storage_backend, created_at';

export async function createCharacterFile({ id, characterId, uploadedBy, kind, originalFilename, mimeType, sizeBytes, isPublic, storageBackend }) {
  const { rows } = await query(
    `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, is_public, storage_backend)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT_COLUMNS}`,
    [id, characterId, uploadedBy, kind, originalFilename, mimeType, sizeBytes, isPublic, storageBackend]
  );
  return rows[0];
}

export async function getCharacterFile(id) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM character_files WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listCharacterFiles(characterId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM character_files WHERE character_id = $1 ORDER BY created_at`,
    [characterId]
  );
  return rows;
}

export async function getCharacterFilesTotalSize(characterId) {
  const { rows } = await query(
    'SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total FROM character_files WHERE character_id = $1',
    [characterId]
  );
  return Number(rows[0].total);
}

export async function deleteCharacterFile(id) {
  const { rows } = await query('DELETE FROM character_files WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

export async function getStorageUsageByBackend() {
  const { rows } = await query(
    "SELECT storage_backend, COALESCE(SUM(size_bytes), 0)::bigint AS total FROM character_files GROUP BY storage_backend"
  );
  const usage = { local: 0, ftp: 0, s3: 0 };
  for (const row of rows) usage[row.storage_backend] = Number(row.total);
  return usage;
}

export async function listCharacterFilesNotOnBackend(backend) {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM character_files WHERE storage_backend != $1`, [backend]);
  return rows;
}

export async function updateCharacterFileStorageBackend(id, backend) {
  await query('UPDATE character_files SET storage_backend = $2 WHERE id = $1', [id, backend]);
}
```

(`getStorageUsageByBackend`/`listCharacterFilesNotOnBackend`/`updateCharacterFileStorageBackend` are new — Task 4's settings routes consume them.)

- [ ] **Step 4: Update `backend/characterFiles/routes.js`**

Replace the whole file:

```javascript
import crypto from 'node:crypto';
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getCharacter } from '../characters/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import { getStorageSettingsForUse } from '../storageSettings/repository.js';
import { getStorage } from '../storage/index.js';
import {
  createCharacterFile,
  getCharacterFile,
  listCharacterFiles,
  getCharacterFilesTotalSize,
  deleteCharacterFile,
} from './repository.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
// A 20MB file base64-encodes to exactly ~26.7MB, before the surrounding
// JSON envelope (field names, other short fields) adds a bit more -- 30MB
// leaves real headroom above that, not just up to the encoded size alone,
// so the *intended* 413 (file too large) is what a too-big upload actually
// hits, rather than an earlier, less specific 400 from readJsonBody's own
// raw-body-size cap firing first.
const MAX_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
const MIME_ALLOWLIST = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  document: ['application/pdf'],
};

function canManage(character, user) {
  return character.user_id === user.id || user.group.canOverrideCheckinStatus;
}

function canView(file, character, user) {
  return file.is_public || canManage(character, user);
}

router.post('/characters/:id/files', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  if (!canManage(character, user)) return { status: 403, body: { error: 'forbidden' } };

  const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { kind, filename, mimeType, dataBase64, isPublic, gdprConsent } = body;

  if (gdprConsent !== true) return { status: 400, body: { error: 'gdprConsent must be true' } };
  if (!MIME_ALLOWLIST[kind]?.includes(mimeType)) {
    return { status: 400, body: { error: `mimeType must be one of: ${Object.values(MIME_ALLOWLIST).flat().join(', ')}, matching kind "${kind}"` } };
  }
  if (typeof filename !== 'string' || !filename) {
    return { status: 400, body: { error: 'filename is required' } };
  }
  // Buffer.from ignores the 'base64' encoding argument for an array-like
  // object (e.g. {length: 4_000_000_000}) and instead allocates a
  // zero-filled buffer of that length -- an unauthenticated-size request
  // body can force a multi-second, memory-exhausting allocation this way.
  if (typeof dataBase64 !== 'string') {
    return { status: 400, body: { error: 'dataBase64 must be a base64 string' } };
  }

  let buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    return { status: 400, body: { error: 'dataBase64 is not valid base64' } };
  }
  if (buffer.length === 0) return { status: 400, body: { error: 'dataBase64 is required' } };
  if (buffer.length > MAX_FILE_BYTES) {
    return { status: 413, body: { error: `file exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB per-file limit` } };
  }

  const settings = await getAppSettings();
  const quotaBytes = settings.quotaMbPerCharacter * 1024 * 1024;
  const currentTotal = await getCharacterFilesTotalSize(character.id);
  if (currentTotal + buffer.length > quotaBytes) {
    return { status: 413, body: { error: 'this character has reached its storage quota' } };
  }

  const id = crypto.randomUUID();
  const storageSettings = await getStorageSettingsForUse();
  const storage = getStorage(storageSettings.backend, storageSettings);
  try {
    await storage.upload(id, buffer);
  } catch (err) {
    return { status: 502, body: { error: `Datei konnte nicht auf dem Speicher-Backend abgelegt werden: ${err.message}` } };
  }

  const file = await createCharacterFile({
    id,
    characterId: character.id,
    uploadedBy: user.id,
    kind,
    originalFilename: filename,
    mimeType,
    sizeBytes: buffer.length,
    isPublic: isPublic === true,
    storageBackend: storageSettings.backend,
  });
  return { status: 201, body: file };
}));

router.get('/characters/:characterId/files', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.characterId);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const files = await listCharacterFiles(character.id);
  const visible = canManage(character, user) ? files : files.filter((f) => f.is_public);
  return { status: 200, body: visible };
}));

router.get('/characters/:characterId/files/:fileId', requireAuth(async ({ params, user }) => {
  const file = await getCharacterFile(params.fileId);
  if (!file || file.character_id !== params.characterId) return { status: 404, body: { error: 'not found' } };
  const character = await getCharacter(file.character_id);
  if (!character || !canView(file, character, user)) return { status: 404, body: { error: 'not found' } };

  const storageSettings = await getStorageSettingsForUse();
  const storage = getStorage(file.storage_backend, storageSettings);
  let data;
  try {
    data = await storage.download(file.id);
  } catch (err) {
    if (file.storage_backend !== 'local') {
      return { status: 502, body: { error: `Datei konnte nicht vom Speicher-Backend geladen werden: ${err.message}` } };
    }
    return { status: 404, body: { error: 'not found' } };
  }

  const safeFilename = file.original_filename.replace(/["\r\n]/g, '');
  return {
    status: 200,
    isBinary: true,
    body: data,
    headers: {
      'Content-Type': file.mime_type,
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      // mime_type is only ever the client's claimed type, never verified
      // against the actual bytes -- this stops a browser from ignoring it
      // and guessing a more "interesting" type (e.g. HTML) to render.
      'X-Content-Type-Options': 'nosniff',
    },
  };
}));

router.delete('/characters/:characterId/files/:fileId', requireAuth(async ({ params, user }) => {
  const file = await getCharacterFile(params.fileId);
  if (!file || file.character_id !== params.characterId) return { status: 404, body: { error: 'not found' } };
  const character = await getCharacter(file.character_id);
  if (!character || !canManage(character, user)) return { status: 403, body: { error: 'forbidden' } };

  await deleteCharacterFile(file.id);
  const storageSettings = await getStorageSettingsForUse();
  const storage = getStorage(file.storage_backend, storageSettings);
  try {
    await storage.remove(file.id);
  } catch (err) {
    if (file.storage_backend !== 'local') {
      return { status: 502, body: { error: `Datei-Zeile gelöscht, aber Entfernen vom Speicher-Backend fehlgeschlagen: ${err.message}` } };
    }
    // local: file already gone from disk (or never wrote successfully) -- the
    // DB row is already deleted, which is what actually controls
    // reachability, so this is not an error condition worth surfacing.
  }
  return { status: 200, body: { deleted: true } };
}));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/integration/characterFiles.test.js`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add backend/characterFiles/repository.js backend/characterFiles/routes.js tests/integration/characterFiles.test.js
git commit -m "feat: route character-file storage through the storage backend abstraction"
```

---

### Task 4: Settings-API (`/admin/settings/storage*`)

**Files:**
- Create: `backend/storageSettings/routes.js`
- Modify: `backend/server.js`
- Test: `tests/integration/storageSettings.test.js`

**Interfaces:**
- Consumes: `getStorageSettings`, `getStorageSettingsForUse`, `setStorageSettings` (Task 1); `getStorage` (Task 2); `getStorageUsageByBackend`, `listCharacterFilesNotOnBackend`, `updateCharacterFileStorageBackend` (Task 3).
- Produces routes: `GET/PUT /admin/settings/storage`, `POST /admin/settings/storage/test`, `GET /admin/settings/storage/usage`, `POST /admin/settings/storage/migrate` — all admin-only.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/storageSettings.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTestServer } from '../testServer.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://app:app@localhost:5433/pakyrion_test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { runMigrations } = await import('../../db/migrate.js');
await runMigrations();

const { seedGroups } = await import('../../db/seedGroups.js');
await seedGroups();

const { query, closePool } = await import('../../backend/db.js');
const { createSession } = await import('../../backend/auth/sessions.js');

async function makeUserAndSession(groupKey = 'sc') {
  const { rows } = await query(
    "INSERT INTO users (email, first_name, last_name, group_id, email_verified) VALUES ($1, 'Storage', 'Settings Test', (SELECT id FROM groups WHERE key = $2), true) RETURNING id",
    [`storage-settings-${groupKey}-${crypto.randomUUID()}@example.com`, groupKey]
  );
  const session = await createSession(rows[0].id);
  return { userId: rows[0].id, cookie: `session=${session.token}` };
}

async function makeCharacter(userId) {
  const { rows } = await query(
    "INSERT INTO characters (user_id, event_id, class, name, data) VALUES ($1, NULL, 'nsc', 'Storage Test Char', '{}') RETURNING id",
    [userId]
  );
  return rows[0].id;
}

test('PUT then GET /admin/settings/storage never returns plaintext secrets', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const putRes = await fetch(`http://localhost:${port}/admin/settings/storage`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        backend: 'ftp',
        ftp: { host: 'ftp.example.com', port: 21, username: 'bot', password: 'ftp-secret', secure: true, baseDir: '/uploads' },
        s3: {},
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.ftp.hasPassword, true);
    assert.ok(!JSON.stringify(putBody).includes('ftp-secret'));

    const getRes = await fetch(`http://localhost:${port}/admin/settings/storage`, { headers: { Cookie: cookie } });
    const getBody = await getRes.json();
    assert.equal(getBody.backend, 'ftp');
    assert.ok(!JSON.stringify(getBody).includes('ftp-secret'));
  });
});

test('GET/PUT/test/usage/migrate on /admin/settings/storage all reject a non-admin group', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('sc');
    const calls = [
      ['GET', '/admin/settings/storage', undefined],
      ['PUT', '/admin/settings/storage', JSON.stringify({ backend: 'local' })],
      ['POST', '/admin/settings/storage/test', JSON.stringify({ backend: 'local' })],
      ['GET', '/admin/settings/storage/usage', undefined],
      ['POST', '/admin/settings/storage/migrate', undefined],
    ];
    for (const [method, path, body] of calls) {
      const res = await fetch(`http://localhost:${port}${path}`, {
        method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body,
      });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });
});

test('test-connection succeeds for the local backend and fails for an unreachable s3 config', async () => {
  await withTestServer(async (port) => {
    const { cookie } = await makeUserAndSession('admin');
    const localRes = await fetch(`http://localhost:${port}/admin/settings/storage/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ backend: 'local' }),
    });
    assert.equal(localRes.status, 200);

    const s3Res = await fetch(`http://localhost:${port}/admin/settings/storage/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ backend: 's3', s3: { bucket: 'x', region: 'us-east-1', endpoint: 'http://127.0.0.1:1', accessKeyId: 'x', secretAccessKey: 'x' } }),
    });
    assert.equal(s3Res.status, 502);
  });
});

test('usage aggregates size_bytes per backend', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('sc');
    const characterId = await makeCharacter(owner.userId);
    await query(
      `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, storage_backend)
       VALUES (gen_random_uuid(), $1, $2, 'document', 'a.pdf', 'application/pdf', 12345, 'local')`,
      [characterId, owner.userId]
    );
    const { cookie } = await makeUserAndSession('admin');
    const res = await fetch(`http://localhost:${port}/admin/settings/storage/usage`, { headers: { Cookie: cookie } });
    const body = await res.json();
    assert.ok(body.local >= 12345);
  });
});

test('migrate reports a broken file as failed instead of crashing or silently dropping it', async () => {
  await withTestServer(async (port) => {
    const owner = await makeUserAndSession('sc');
    const characterId = await makeCharacter(owner.userId);
    const { rows } = await query(
      `INSERT INTO character_files (id, character_id, uploaded_by, kind, original_filename, mime_type, size_bytes, storage_backend)
       VALUES (gen_random_uuid(), $1, $2, 'image', 'x.png', 'image/png', 10, 's3') RETURNING id`,
      [characterId, owner.userId]
    );
    const brokenFileId = rows[0].id;

    await query(
      `INSERT INTO storage_settings (backend, s3_bucket, s3_region, s3_endpoint, s3_access_key_id)
       VALUES ('local', 'nonexistent', 'us-east-1', 'http://127.0.0.1:1', 'x')`
    );
    try {
      const { cookie } = await makeUserAndSession('admin');
      const res = await fetch(`http://localhost:${port}/admin/settings/storage/migrate`, {
        method: 'POST', headers: { Cookie: cookie },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.migrated, 0);
      assert.equal(body.failed.length, 1);
      assert.equal(body.failed[0].id, brokenFileId);
    } finally {
      await query('DELETE FROM storage_settings');
    }
  });
});

test.after(async () => {
  await query("DELETE FROM characters WHERE name = 'Storage Test Char'");
  await query("DELETE FROM users WHERE email LIKE 'storage-settings-%'");
  await query('DELETE FROM storage_settings');
  await closePool();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/storageSettings.test.js`
Expected: FAIL — every request 404s (no routes registered yet).

- [ ] **Step 3: Implement `backend/storageSettings/routes.js`**

```javascript
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { requireAdminGroup } from '../middleware/authorize.js';
import { readJsonBody } from '../httpBody.js';
import { getStorageSettings, getStorageSettingsForUse, setStorageSettings } from './repository.js';
import { getStorage } from '../storage/index.js';
import {
  getStorageUsageByBackend,
  listCharacterFilesNotOnBackend,
  updateCharacterFileStorageBackend,
} from '../characterFiles/repository.js';

const VALID_BACKENDS = ['local', 'ftp', 's3'];

router.get('/admin/settings/storage', requireAuth(requireAdminGroup(async () => {
  const settings = await getStorageSettings();
  return { status: 200, body: settings };
})));

router.put('/admin/settings/storage', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { backend, ftp, s3 } = body;
  if (!VALID_BACKENDS.includes(backend)) {
    return { status: 400, body: { error: "backend must be 'local', 'ftp', or 's3'" } };
  }
  const saved = await setStorageSettings({ backend, ftp: ftp ?? {}, s3: s3 ?? {} });
  return { status: 200, body: saved };
})));

router.post('/admin/settings/storage/test', requireAuth(requireAdminGroup(async ({ req }) => {
  const body = await readJsonBody(req);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { backend, ftp, s3 } = body;
  if (!VALID_BACKENDS.includes(backend)) {
    return { status: 400, body: { error: "backend must be 'local', 'ftp', or 's3'" } };
  }

  let effectiveFtp = ftp ?? {};
  let effectiveS3 = s3 ?? {};
  if (backend === 'ftp' && !effectiveFtp.password) {
    const saved = await getStorageSettingsForUse();
    if (saved.ftp.username === effectiveFtp.username) effectiveFtp = { ...effectiveFtp, password: saved.ftp.password };
  }
  if (backend === 's3' && !effectiveS3.secretAccessKey) {
    const saved = await getStorageSettingsForUse();
    if (saved.s3.accessKeyId === effectiveS3.accessKeyId) effectiveS3 = { ...effectiveS3, secretAccessKey: saved.s3.secretAccessKey };
  }

  const storage = getStorage(backend, { ftp: effectiveFtp, s3: effectiveS3 });
  try {
    await storage.testConnection();
    return { status: 200, body: { connected: true } };
  } catch (err) {
    return { status: 502, body: { error: `Verbindungstest fehlgeschlagen: ${err.message}` } };
  }
})));

router.get('/admin/settings/storage/usage', requireAuth(requireAdminGroup(async () => {
  const usage = await getStorageUsageByBackend();
  return { status: 200, body: usage };
})));

router.post('/admin/settings/storage/migrate', requireAuth(requireAdminGroup(async () => {
  const settings = await getStorageSettingsForUse();
  const targetBackend = settings.backend;
  const targetStorage = getStorage(targetBackend, settings);
  const files = await listCharacterFilesNotOnBackend(targetBackend);

  let migrated = 0;
  const failed = [];
  for (const file of files) {
    const sourceStorage = getStorage(file.storage_backend, settings);
    try {
      const data = await sourceStorage.download(file.id);
      await targetStorage.upload(file.id, data);
      await updateCharacterFileStorageBackend(file.id, targetBackend);
      await sourceStorage.remove(file.id);
      migrated += 1;
    } catch (err) {
      failed.push({ id: file.id, error: err.message });
    }
  }
  return { status: 200, body: { migrated, failed } };
})));
```

- [ ] **Step 4: Register the routes in `backend/server.js`**

Find the block of route-module imports (`import './smtpSettings/routes.js';` / `import './appSettings/routes.js';`) and add, after the `appSettings` import:

```javascript
import './storageSettings/routes.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/integration/storageSettings.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/storageSettings/routes.js backend/server.js tests/integration/storageSettings.test.js
git commit -m "feat: add admin storage settings API (config, test, usage, migrate)"
```

---

### Task 5: Admin-UI (`admin/storage.html`) + Nav + Full-Suite-Gate

**Files:**
- Create: `frontend/admin/storage.html`
- Modify: `frontend/js/nav.js`

**Interfaces:**
- Consumes: `GET/PUT /admin/settings/storage`, `POST /admin/settings/storage/test`, `GET /admin/settings/storage/usage`, `POST /admin/settings/storage/migrate` (Task 4); `api` from `frontend/js/api.js`; `renderNavLinks` from `frontend/js/nav.js`; `applyBranding` from `frontend/js/branding.js`.

- [ ] **Step 1: Add the nav entry**

In `frontend/js/nav.js`, inside the `if (account.group.key === 'admin')` block, add a line after the existing `branding` push:

```javascript
    links.push({ key: 'speicher', label: 'Speicher', href: '/admin/storage.html' });
```

- [ ] **Step 2: Create `frontend/admin/storage.html`**

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Speicher – Pakyrion Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/everest-registry.css">
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-brand">Pakyrion<span>Admin</span></div>
    <nav id="nav-links"></nav>
    <div class="sidebar-foot"><a href="#" id="logout-link">Logout</a></div>
  </aside>
  <div class="main"><div class="content">
    <h1>Speicher</h1>
    <p class="sub">Wo hochgeladene Charakter-Dateien gespeichert werden.</p>

    <div class="card form-pad">
      <form id="storage-form">
        <label for="backend-select">Backend</label>
        <select id="backend-select" name="backend">
          <option value="local">Lokal</option>
          <option value="ftp">FTP</option>
          <option value="s3">S3</option>
        </select>

        <fieldset id="ftp-fields" hidden>
          <legend>FTP</legend>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div><label for="ftp-host">Host</label><input id="ftp-host" name="ftpHost" type="text"></div>
            <div><label for="ftp-port">Port</label><input id="ftp-port" name="ftpPort" type="number" placeholder="21"></div>
            <div><label for="ftp-username">Benutzername</label><input id="ftp-username" name="ftpUsername" type="text"></div>
            <div><label for="ftp-password">Passwort</label><input id="ftp-password" name="ftpPassword" type="password" placeholder="Leer lassen, um das bestehende Passwort zu behalten"></div>
            <div><label for="ftp-basedir">Basis-Verzeichnis</label><input id="ftp-basedir" name="ftpBaseDir" type="text" placeholder="/uploads"></div>
            <div><label for="ftp-secure"><input id="ftp-secure" name="ftpSecure" type="checkbox" checked> FTPS (verschlüsselt)</label></div>
          </div>
        </fieldset>

        <fieldset id="s3-fields" hidden>
          <legend>S3</legend>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div><label for="s3-bucket">Bucket</label><input id="s3-bucket" name="s3Bucket" type="text"></div>
            <div><label for="s3-region">Region</label><input id="s3-region" name="s3Region" type="text" placeholder="eu-central-1"></div>
            <div><label for="s3-endpoint">Endpoint (optional, für S3-kompatible Dienste)</label><input id="s3-endpoint" name="s3Endpoint" type="text" placeholder="https://s3.example.com"></div>
            <div><label for="s3-access-key">Access Key ID</label><input id="s3-access-key" name="s3AccessKeyId" type="text"></div>
            <div><label for="s3-secret-key">Secret Access Key</label><input id="s3-secret-key" name="s3SecretAccessKey" type="password" placeholder="Leer lassen, um den bestehenden Schlüssel zu behalten"></div>
          </div>
        </fieldset>

        <button type="submit">Speichern</button>
        <button type="button" id="test-connection">Verbindung testen</button>
      </form>
    </div>

    <div class="card form-pad">
      <h2>Speicherverbrauch</h2>
      <svg id="usage-chart" viewBox="0 0 400 90" width="400" height="90" role="img" aria-label="Speicherverbrauch pro Backend"></svg>
    </div>

    <div class="card form-pad">
      <h2>Migration</h2>
      <p class="sub">Verschiebt alle Dateien, die noch nicht auf dem aktuell aktiven Backend liegen, dorthin.</p>
      <button type="button" id="migrate-button">Migrieren</button>
      <span id="migrate-spinner" hidden>Migriere…</span>
      <p id="migrate-result"></p>
    </div>

    <p id="message"></p>
  </div></div>
</div>

<script type="module">
import { api } from '/js/api.js';
import { applyBranding } from '/js/branding.js';
applyBranding();
import { renderNavLinks } from '/js/nav.js';

const form = document.getElementById('storage-form');
const message = document.getElementById('message');
const backendSelect = document.getElementById('backend-select');
const ftpFields = document.getElementById('ftp-fields');
const s3Fields = document.getElementById('s3-fields');

function updateVisibleFields() {
  ftpFields.hidden = backendSelect.value !== 'ftp';
  s3Fields.hidden = backendSelect.value !== 's3';
}
backendSelect.addEventListener('change', updateVisibleFields);

function formToPayload(data) {
  return {
    backend: data.backend,
    ftp: {
      host: data.ftpHost || null,
      port: data.ftpPort ? Number(data.ftpPort) : null,
      username: data.ftpUsername || null,
      password: data.ftpPassword || undefined,
      secure: data.ftpSecure === 'on',
      baseDir: data.ftpBaseDir || null,
    },
    s3: {
      bucket: data.s3Bucket || null,
      region: data.s3Region || null,
      endpoint: data.s3Endpoint || null,
      accessKeyId: data.s3AccessKeyId || null,
      secretAccessKey: data.s3SecretAccessKey || undefined,
    },
  };
}

async function loadSettings() {
  const settings = await api.get('/admin/settings/storage');
  backendSelect.value = settings.backend;
  form.elements.ftpHost.value = settings.ftp.host ?? '';
  form.elements.ftpPort.value = settings.ftp.port ?? '';
  form.elements.ftpUsername.value = settings.ftp.username ?? '';
  form.elements.ftpPassword.placeholder = settings.ftp.hasPassword
    ? 'Gesetzt — leer lassen, um es zu behalten'
    : 'Leer lassen, um das bestehende Passwort zu behalten';
  form.elements.ftpSecure.checked = settings.ftp.secure;
  form.elements.ftpBaseDir.value = settings.ftp.baseDir ?? '';
  form.elements.s3Bucket.value = settings.s3.bucket ?? '';
  form.elements.s3Region.value = settings.s3.region ?? '';
  form.elements.s3Endpoint.value = settings.s3.endpoint ?? '';
  form.elements.s3AccessKeyId.value = settings.s3.accessKeyId ?? '';
  form.elements.s3SecretAccessKey.placeholder = settings.s3.hasSecretKey
    ? 'Gesetzt — leer lassen, um ihn zu behalten'
    : 'Leer lassen, um den bestehenden Schlüssel zu behalten';
  updateVisibleFields();
}

function renderUsageChart(usage) {
  const entries = [['Lokal', usage.local], ['FTP', usage.ftp], ['S3', usage.s3]];
  const max = Math.max(1, ...entries.map(([, bytes]) => bytes));
  const svg = document.getElementById('usage-chart');
  const barHeight = 20;
  const gap = 10;
  const chartWidth = 260;
  svg.innerHTML = entries.map(([label, bytes], i) => {
    const y = i * (barHeight + gap);
    const width = Math.max(2, (bytes / max) * chartWidth);
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    return `
      <text x="0" y="${y + barHeight - 5}" font-size="12">${label}</text>
      <rect x="60" y="${y}" width="${width}" height="${barHeight}" fill="currentColor"></rect>
      <text x="${60 + chartWidth + 10}" y="${y + barHeight - 5}" font-size="12">${mb} MB</text>
    `;
  }).join('');
}

async function loadUsage() {
  const usage = await api.get('/admin/settings/storage/usage');
  renderUsageChart(usage);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.className = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    await api.put('/admin/settings/storage', formToPayload(data));
    message.textContent = 'Gespeichert.';
    message.className = 'success';
    form.elements.ftpPassword.value = '';
    form.elements.s3SecretAccessKey.value = '';
    await loadSettings();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});

document.getElementById('test-connection').addEventListener('click', async () => {
  message.textContent = '';
  message.className = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    await api.post('/admin/settings/storage/test', formToPayload(data));
    message.textContent = 'Verbindung erfolgreich.';
    message.className = 'success';
  } catch (err) {
    message.textContent = err.message;
    message.className = 'error';
  }
});

document.getElementById('migrate-button').addEventListener('click', async () => {
  const spinner = document.getElementById('migrate-spinner');
  const result = document.getElementById('migrate-result');
  result.textContent = '';
  spinner.hidden = false;
  try {
    const { migrated, failed } = await api.post('/admin/settings/storage/migrate', {});
    result.textContent = failed.length === 0
      ? `${migrated} Datei(en) migriert.`
      : `${migrated} Datei(en) migriert, ${failed.length} fehlgeschlagen: ${failed.map((f) => f.error).join('; ')}`;
    await loadUsage();
  } catch (err) {
    result.textContent = err.message;
  } finally {
    spinner.hidden = true;
  }
});

document.getElementById('logout-link').addEventListener('click', async (evt) => {
  evt.preventDefault();
  await api.post('/auth/logout', {});
  window.location.href = '/login.html';
});

try {
  const account = await api.get('/account');
  document.getElementById('nav-links').innerHTML = renderNavLinks(account, window.location.pathname);
  await loadSettings();
  await loadUsage();
} catch (err) {
  if (err.status === 401) window.location.href = '/login.html';
  else if (err.status === 403) { message.textContent = 'Kein Zugriff – nur für Admins.'; message.className = 'error'; }
}
</script>
</body>
</html>
```

- [ ] **Step 3: Manual browser verification**

Using the Claude Browser tooling (no DOM test framework in this project, matching the existing manual-verification precedent for every other admin HTML page):
1. Start the dev stack (`docker compose -f docker-compose.dev.yml up`), log in as an `admin` user.
2. Navigate to `/admin/storage.html`. Confirm the "Speicher" nav link is present and the page loads with "Lokal" pre-selected, both `fieldset`s hidden.
3. Select "FTP" in the dropdown — confirm the FTP fields appear and the S3 fields stay hidden. Select "S3" — confirm the reverse.
4. Select "Lokal", click "Verbindung testen" — confirm a success message appears.
5. Upload a character file on `characters.html` first (any test character), then reload `/admin/storage.html` and confirm the "Lokal" bar in the usage chart reflects a non-zero size.
6. Click "Migrieren" with "Lokal" active — confirm the spinner shows briefly and a result message like "0 Datei(en) migriert." appears (nothing to migrate since everything is already local).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — every test in the suite green, including all new tests added across Tasks 1-4.

- [ ] **Step 5: Commit**

```bash
git add frontend/admin/storage.html frontend/js/nav.js
git commit -m "feat: add admin storage settings page (backend selection, usage chart, migration)"
```
