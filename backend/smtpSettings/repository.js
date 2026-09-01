import { query } from '../db.js';
import { encryptField, decryptField } from '../crypto/fieldCrypto.js';

export async function getSmtpSettings() {
  const { rows } = await query('SELECT host, port, username, password_enc, from_address FROM smtp_settings LIMIT 1');
  if (rows.length === 0) return null;
  return {
    host: rows[0].host,
    port: rows[0].port,
    username: rows[0].username,
    hasPassword: rows[0].password_enc !== null,
    fromAddress: rows[0].from_address,
  };
}

export async function getSmtpSettingsForSending() {
  const { rows } = await query('SELECT host, port, username, password_enc, from_address FROM smtp_settings LIMIT 1');
  if (rows.length === 0) return null;
  return {
    host: rows[0].host,
    port: rows[0].port,
    username: rows[0].username,
    password: decryptField(rows[0].password_enc),
    fromAddress: rows[0].from_address,
  };
}

export async function setSmtpSettings({ host, port, username, password, fromAddress }) {
  const { rows } = await query('SELECT id FROM smtp_settings LIMIT 1');
  const passwordEnc = password ? encryptField(password) : null;
  if (rows.length === 0) {
    await query(
      'INSERT INTO smtp_settings (host, port, username, password_enc, from_address) VALUES ($1, $2, $3, $4, $5)',
      [host ?? null, port ?? null, username ?? null, passwordEnc, fromAddress ?? null]
    );
  } else {
    await query(
      `UPDATE smtp_settings SET host = $2, port = $3, username = $4, password_enc = COALESCE($5, password_enc), from_address = $6 WHERE id = $1`,
      [rows[0].id, host ?? null, port ?? null, username ?? null, passwordEnc, fromAddress ?? null]
    );
  }
  return getSmtpSettings();
}
