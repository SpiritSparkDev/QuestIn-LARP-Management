import { encryptField, decryptField } from './crypto/fieldCrypto.js';

export const ACCOUNT_FIELD_KEYS = [
  'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone',
  'medicalNotes', 'group',
];

// Encrypted-at-rest member (OT) fields, mapped to their column. 'group' is
// deliberately excluded: it's an access-control field, not personal data.
export const ENCRYPTED_ACCOUNT_FIELD_COLUMNS = {
  address: 'address_enc',
  birthdate: 'birthdate_enc',
  phone: 'phone_enc',
  emergencyContactLastName: 'emergency_contact_last_name_enc',
  emergencyContactFirstName: 'emergency_contact_first_name_enc',
  emergencyContactPhone: 'emergency_contact_phone_enc',
  medicalNotes: 'medical_notes_enc',
};

const ENCRYPTED_FIELD_KEYS = Object.keys(ENCRYPTED_ACCOUNT_FIELD_COLUMNS);

// Decrypts every OT field out of a row that carries the *_enc columns above
// (aliased or not), keyed back to their camelCase field name.
export function decryptEncryptedAccountFields(row) {
  const result = {};
  for (const key of ENCRYPTED_FIELD_KEYS) {
    result[key] = decryptField(row[ENCRYPTED_ACCOUNT_FIELD_COLUMNS[key]]);
  }
  return result;
}

// Encrypts whichever of the 7 OT fields are present in `fields`, always in
// ENCRYPTED_ACCOUNT_FIELD_COLUMNS order -- callers append the result to their
// own COALESCE UPDATE param list, after their entity-specific columns.
export function encryptAccountFieldValues(fields) {
  return ENCRYPTED_FIELD_KEYS.map((key) => (fields[key] !== undefined ? encryptField(fields[key]) : null));
}
