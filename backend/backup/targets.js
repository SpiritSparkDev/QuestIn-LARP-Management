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
const EMPTY = { s3: {}, sftp: {}, schedule: {} };

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
  // The schedule never returns its passphrase (only that one is stored).
  const { passphrase, ...schedule } = config.schedule ?? {};
  masked.schedule = { ...schedule, hasPassphrase: Boolean(passphrase) };
  return masked;
}

const SCOPES = ['participants', 'events', 'all'];

// Validates the user-editable parts of the schedule; a blank passphrase keeps the stored one. Run state
// (lastRunAt ...) is only ever written by the scheduler itself.
function mergeSchedule(current, input) {
  if (input === undefined) return current;
  const next = { ...current };
  if (input.enabled !== undefined) next.enabled = input.enabled === true;
  if (input.every !== undefined) {
    if (!['day', 'week'].includes(input.every)) throw new Error('every must be day or week');
    next.every = input.every;
  }
  if (input.time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('time must look like 03:15');
    next.time = input.time;
  }
  if (input.weekday !== undefined) {
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) throw new Error('weekday must be 0-6');
    next.weekday = input.weekday;
  }
  if (input.scope !== undefined) {
    if (!SCOPES.includes(input.scope)) throw new Error('scope must be participants, events or all');
    next.scope = input.scope;
  }
  if (input.targets !== undefined) {
    if (!Array.isArray(input.targets) || input.targets.some((t) => !TARGETS.includes(t))) throw new Error('targets must be a list of: ' + TARGETS.join(', '));
    next.targets = [...new Set(input.targets)];
  }
  if (input.keep !== undefined) {
    if (!Number.isInteger(input.keep) || input.keep < 1 || input.keep > 365) throw new Error('keep must be 1-365');
    next.keep = input.keep;
  }
  if (typeof input.passphrase === 'string' && input.passphrase) {
    if (input.passphrase.length < 8) throw new Error('Das Passwort der geplanten Sicherung muss mindestens 8 Zeichen haben.');
    next.passphrase = input.passphrase;
  }
  if (next.enabled) {
    if (!next.passphrase) throw new Error('Für die geplante Sicherung ist ein Passwort nötig (die Datei enthält personenbezogene Daten).');
    if (!(next.targets ?? []).length) throw new Error('Wähle mindestens ein Ziel für die geplante Sicherung.');
    // Switched on just now: the first run is the next slot, not "immediately because today's slot has passed".
    if (!current.enabled) next.lastRunAt = new Date().toISOString();
  }
  return next;
}

// Run state written by the scheduler (kept out of mergeSchedule so users cannot set it).
export async function saveScheduleState(patch) {
  const current = await getBackupSettingsForUse();
  const next = { ...current, schedule: { ...current.schedule, ...patch } };
  const blob = encryptField(JSON.stringify(next));
  const { rows } = await query('SELECT id FROM backup_settings LIMIT 1');
  if (rows.length === 0) await query('INSERT INTO backup_settings (config_enc) VALUES ($1)', [blob]);
  else await query('UPDATE backup_settings SET config_enc = $1, updated_at = now() WHERE id = $2', [blob, rows[0].id]);
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
  next.schedule = mergeSchedule(current.schedule ?? {}, input?.schedule);
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
