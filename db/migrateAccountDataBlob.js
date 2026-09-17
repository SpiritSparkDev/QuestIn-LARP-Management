import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { decryptField } from '../backend/crypto/fieldCrypto.js';
import { encryptFieldBlob } from '../backend/accountFields.js';

const OLD_COLUMNS = {
  address: 'address_enc',
  birthdate: 'birthdate_enc',
  phone: 'phone_enc',
  emergencyContactLastName: 'emergency_contact_last_name_enc',
  emergencyContactFirstName: 'emergency_contact_first_name_enc',
  emergencyContactPhone: 'emergency_contact_phone_enc',
  medicalNotes: 'medical_notes_enc',
};
const OLD_COLUMN_NAMES = Object.values(OLD_COLUMNS);

// birthdate used to be free text typed via a TT.MM.JJJJ (German DD.MM.YYYY)
// formatting helper; the new schema-driven field renders it as a native
// <input type="date">, which requires ISO YYYY-MM-DD and otherwise silently
// blanks the value (and the next save would then overwrite the real value
// with an empty string -- silent PII loss). Converts only the exact old
// German format; anything else (already-ISO, blank, partial, garbage) is
// left completely unchanged, same as it would render today.
export function normalizeBirthdateValue(value) {
  if (typeof value === 'string' && /^\d{2}\.\d{2}\.\d{4}$/.test(value)) {
    const [day, month, year] = value.split('.');
    return `${year}-${month}-${day}`;
  }
  return value;
}

// One-time, idempotent data migration: decrypts the 7 old per-field
// encrypted columns on users/invitations, merges them into a single JSON
// blob, and writes it to the new account_data_enc column -- can't be a
// plain .sql migration (see db/migrations/034_account_data_blob.sql)
// because the transform needs ENCRYPTION_KEY-based application crypto, not
// anything expressible in pure SQL. Drops the old columns itself, in the
// same transaction as the backfill, once every row has been converted.
export async function migrateAccountDataBlob() {
  await withTransaction(async (client) => {
    const { rows: existingColumns } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = ANY($1)`,
      [OLD_COLUMN_NAMES]
    );
    if (existingColumns.length === 0) {
      logger.info('account data blob migration skipped: old columns already dropped');
      return;
    }

    for (const table of ['users', 'invitations']) {
      const { rows } = await client.query(`SELECT id, ${OLD_COLUMN_NAMES.join(', ')} FROM ${table}`);
      for (const row of rows) {
        const data = {};
        for (const [key, column] of Object.entries(OLD_COLUMNS)) {
          const value = decryptField(row[column]);
          if (value !== null) data[key] = key === 'birthdate' ? normalizeBirthdateValue(value) : value;
        }
        await client.query(`UPDATE ${table} SET account_data_enc = $1 WHERE id = $2`, [encryptFieldBlob(data), row.id]);
      }
    }

    await client.query(`ALTER TABLE users ${OLD_COLUMN_NAMES.map((c) => `DROP COLUMN ${c}`).join(', ')}`);
    await client.query(`ALTER TABLE invitations ${OLD_COLUMN_NAMES.map((c) => `DROP COLUMN ${c}`).join(', ')}`);
    logger.info('account data blob migration complete');
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrateAccountDataBlob()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('account data blob migration failed', { error: err.message });
      process.exit(1);
    });
}
