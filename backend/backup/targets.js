import fs from 'node:fs/promises';
import path from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';
import { s3Storage } from '../storage/s3.js';

// Targets a backup can be sent to besides the browser download:
//   local  -- a folder on the server (BACKUP_LOCAL_DIR, default ./backups; mount a volume there)
//   s3     -- any S3-compatible bucket
//   sftp   -- an SFTP server
// Credentials live in one encrypted block (backup_settings); the API never returns secrets.
export const TARGETS = ['local', 's3', 'sftp'];
const SECRET_FIELDS = { s3: ['secretAccessKey'], sftp: ['password', 'privateKey'] };
const EMPTY = { s3: {}, sftp: {} };

export function localDir() {
  return path.resolve(process.env.BACKUP_LOCAL_DIR || './backups');
}

export async function getBackupSettingsForUse() {
  const { rows } = await query('SELECT config_enc FROM backup_settings LIMIT 1');
  if (!rows[0]?.config_enc) return structuredClone(EMPTY);
  try {
    return { ...EMPTY, ...JSON.parse(decryptField(rows[0].config_enc)) };
  } catch {
    return structuredClone(EMPTY);
  }
}

// Same data without the secrets; `has<Secret>` tells the form whether one is stored.
export async function getBackupSettings() {
  const config = await getBackupSettingsForUse();
  const masked = { local: { dir: localDir() } };
  for (const target of ['s3', 'sftp']) {
    masked[target] = { ...config[target] };
    for (const field of SECRET_FIELDS[target]) {
      masked[target][`has${field[0].toUpperCase()}${field.slice(1)}`] = Boolean(config[target][field]);
      delete masked[target][field];
    }
  }
  return masked;
}

// A blank secret keeps the stored one (same convention as the storage settings).
export async function setBackupSettings(input) {
  const current = await getBackupSettingsForUse();
  const next = structuredClone(EMPTY);
  for (const target of ['s3', 'sftp']) {
    next[target] = { ...current[target], ...Object.fromEntries(Object.entries(input?.[target] ?? {}).filter(([key, value]) => typeof value === 'string' || typeof value === 'number')) };
    for (const field of SECRET_FIELDS[target]) {
      if (!input?.[target]?.[field]) next[target][field] = current[target][field];
    }
  }
  const blob = encryptField(JSON.stringify(next));
  const { rows } = await query('SELECT id FROM backup_settings LIMIT 1');
  if (rows.length === 0) await query('INSERT INTO backup_settings (config_enc) VALUES ($1)', [blob]);
  else await query('UPDATE backup_settings SET config_enc = $1, updated_at = now() WHERE id = $2', [blob, rows[0].id]);
}

async function withSftp(config, fn) {
  if (!config.host || !config.username) throw new Error('SFTP ist nicht eingerichtet (Server und Benutzer fehlen).');
  const client = new SftpClient();
  try {
    await client.connect({
      host: config.host,
      port: Number(config.port) || 22,
      username: config.username,
      password: config.password || undefined,
      privateKey: config.privateKey || undefined,
      readyTimeout: 15000,
    });
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

const remoteDir = (config) => (config.dir || '/').replace(/\/+$/, '') || '/';

export async function testTarget(target) {
  const config = await getBackupSettingsForUse();
  if (target === 'local') {
    await fs.mkdir(localDir(), { recursive: true });
    await fs.access(localDir(), fs.constants.W_OK);
  } else if (target === 's3') {
    if (!config.s3.bucket) throw new Error('S3 ist nicht eingerichtet (Bucket fehlt).');
    await s3Storage(config.s3).testConnection();
  } else if (target === 'sftp') {
    await withSftp(config.sftp, (client) => client.list(remoteDir(config.sftp)));
  }
}

// Sends one backup file to one target. Returns a short description of where it went.
export async function deliver(target, filename, buffer) {
  const config = await getBackupSettingsForUse();
  if (target === 'local') {
    await fs.mkdir(localDir(), { recursive: true });
    await fs.writeFile(path.join(localDir(), filename), buffer);
    return `Server-Ordner ${localDir()}`;
  }
  if (target === 's3') {
    if (!config.s3.bucket) throw new Error('S3 ist nicht eingerichtet (Bucket fehlt).');
    const key = `${(config.s3.prefix || '').replace(/^\/+|\/+$/g, '')}/${filename}`.replace(/^\//, '');
    await s3Storage(config.s3).upload(key, buffer);
    return `S3 ${config.s3.bucket}/${key}`;
  }
  if (target === 'sftp') {
    const dir = remoteDir(config.sftp);
    await withSftp(config.sftp, async (client) => {
      await client.mkdir(dir, true);
      await client.put(buffer, `${dir === '/' ? '' : dir}/${filename}`);
    });
    return `SFTP ${config.sftp.host}:${dir}`;
  }
  throw new Error(`Unbekanntes Ziel: ${target}`);
}
