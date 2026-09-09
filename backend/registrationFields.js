import { encryptField, decryptField } from './crypto/fieldCrypto.js';

// The 6 event-scoped OT fields living on registrations (moved off the
// account in Teil 3 of the user-testing feedback package) -- same
// encrypted-column pattern as accountFields.js, gated by the same
// group.accountFields permission list (see
// registrations/repository.js's listParticipantsForEvent).
export const REGISTRATION_FIELD_KEYS = [
  'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut',
];

export const ENCRYPTED_REGISTRATION_FIELD_COLUMNS = {
  conTage: 'con_tage_enc',
  accommodation: 'accommodation_enc',
  craftOffer: 'craft_offer_enc',
  travelMethod: 'travel_method_enc',
  dataSharingOptOut: 'data_sharing_opt_out_enc',
  photoOptOut: 'photo_opt_out_enc',
};

const ENCRYPTED_FIELD_KEYS = Object.keys(ENCRYPTED_REGISTRATION_FIELD_COLUMNS);

// Decrypts every registration OT field out of a row that carries the
// *_enc columns above (aliased or not), keyed back to their camelCase
// field name.
export function decryptEncryptedRegistrationFields(row) {
  const result = {};
  for (const key of ENCRYPTED_FIELD_KEYS) {
    result[key] = decryptField(row[ENCRYPTED_REGISTRATION_FIELD_COLUMNS[key]]);
  }
  return result;
}

// Encrypts whichever of the 6 fields are present in `fields`, always in
// ENCRYPTED_REGISTRATION_FIELD_COLUMNS order -- callers append the result
// to their own COALESCE UPDATE/INSERT param list.
export function encryptRegistrationFieldValues(fields) {
  return ENCRYPTED_FIELD_KEYS.map((key) => (fields[key] !== undefined ? encryptField(fields[key]) : null));
}
