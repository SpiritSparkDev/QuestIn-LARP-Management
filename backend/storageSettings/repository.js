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

function safeDecrypt(buffer) {
  try {
    return decryptField(buffer);
  } catch {
    return null;
  }
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
    ftp: { host: r.ftp_host, port: r.ftp_port, username: r.ftp_username, password: safeDecrypt(r.ftp_password_enc), secure: r.ftp_secure, baseDir: r.ftp_base_dir },
    s3: { bucket: r.s3_bucket, region: r.s3_region, endpoint: r.s3_endpoint, accessKeyId: r.s3_access_key_id, secretAccessKey: safeDecrypt(r.s3_secret_access_key_enc) },
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
