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
  const files = await listCharacterFilesNotOnBackend(targetBackend);

  const storageCache = new Map();
  function cachedStorage(backend) {
    if (!storageCache.has(backend)) storageCache.set(backend, getStorage(backend, settings));
    return storageCache.get(backend);
  }
  const targetStorage = cachedStorage(targetBackend);

  let migrated = 0;
  const failed = [];
  for (const file of files) {
    const sourceStorage = cachedStorage(file.storage_backend);
    try {
      const data = await sourceStorage.download(file.id);
      await targetStorage.upload(file.id, data);
      await updateCharacterFileStorageBackend(file.id, targetBackend);
      migrated += 1;
    } catch (err) {
      failed.push({ id: file.id, error: err.message });
      continue;
    }
    try {
      await sourceStorage.remove(file.id);
    } catch (err) {
      failed.push({ id: file.id, error: `migriert, aber alte Kopie auf ${file.storage_backend} konnte nicht entfernt werden: ${err.message}` });
    }
  }
  return { status: 200, body: { migrated, failed } };
})));
