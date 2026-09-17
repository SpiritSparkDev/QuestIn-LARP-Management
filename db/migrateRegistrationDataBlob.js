import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction, closePool } from '../backend/db.js';
import { logger } from '../backend/logger.js';
import { decryptField } from '../backend/crypto/fieldCrypto.js';
import { encryptFieldBlob } from '../backend/registrationFields.js';

const OLD_COLUMNS = {
  conTage: 'con_tage_enc',
  accommodation: 'accommodation_enc',
  craftOffer: 'craft_offer_enc',
  travelMethod: 'travel_method_enc',
  dataSharingOptOut: 'data_sharing_opt_out_enc',
  photoOptOut: 'photo_opt_out_enc',
};
const OLD_COLUMN_NAMES = Object.values(OLD_COLUMNS);

// Legacy free-text 'Ja'/'Nein' opt-outs become real booleans, since the
// seeded schema types both fields `boolean` and a truthy 'Nein' string
// would otherwise render as checked (opted out) for every existing
// registration -- inverting the displayed consent state.
export function normalizeBooleanValue(value) {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ja') return true;
  if (normalized === 'nein') return false;
  return value;
}

const BOOLEAN_KEYS = ['dataSharingOptOut', 'photoOptOut'];

// One-time, idempotent data migration -- see db/migrateAccountDataBlob.js
// for the equivalent on users/invitations; same reasoning, one table here.
export async function migrateRegistrationDataBlob() {
  await withTransaction(async (client) => {
    const { rows: existingColumns } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'registrations' AND column_name = ANY($1)`,
      [OLD_COLUMN_NAMES]
    );
    if (existingColumns.length === 0) {
      logger.info('registration data blob migration skipped: old columns already dropped');
      return;
    }

    const { rows } = await client.query(`SELECT user_id, event_id, ${OLD_COLUMN_NAMES.join(', ')} FROM registrations`);
    for (const row of rows) {
      const data = {};
      for (const [key, column] of Object.entries(OLD_COLUMNS)) {
        const value = decryptField(row[column]);
        if (value !== null) data[key] = BOOLEAN_KEYS.includes(key) ? normalizeBooleanValue(value) : value;
      }
      await client.query(
        'UPDATE registrations SET registration_data_enc = $1 WHERE user_id = $2 AND event_id = $3 AND registration_data_enc IS NULL',
        [encryptFieldBlob(data), row.user_id, row.event_id]
      );
    }

    await client.query(`ALTER TABLE registrations ${OLD_COLUMN_NAMES.map((c) => `DROP COLUMN ${c}`).join(', ')}`);
    logger.info('registration data blob migration complete');
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrateRegistrationDataBlob()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('registration data blob migration failed', { error: err.message });
      process.exit(1);
    });
}
