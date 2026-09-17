import { encryptField, decryptField } from './crypto/fieldCrypto.js';

// OT (out-of-time) account fields -- the field DEFINITIONS (key, label,
// type) now live in the admin-editable account_field_schema (see
// backend/accountFieldSchema). Consumers that need the current key set
// (backend/groups/routes.js, backend/members/routes.js) fetch the live
// schema instead of a static list.

// The personal-data subset of the account field keys -- excludes 'group',
// which is an access-control field stored in its own column, not in the
// account_data_enc blob. This is a fixed, hardcoded set (unlike the
// admin-editable schema) because it must match the old one-column-per-field
// defaults below regardless of what admins add/remove from the schema.
const PERSONAL_ACCOUNT_FIELD_KEYS = [
  'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone',
  'medicalNotes',
];

// Encrypts/decrypts the single JSON blob of account (OT) field values --
// replaces one *_enc column per field now that the field set is dynamic
// (admin-editable via account_field_schema).
export function encryptFieldBlob(values) {
  return encryptField(JSON.stringify(values ?? {}));
}

export function decryptFieldBlob(buffer) {
  const json = decryptField(buffer);
  const data = json ? JSON.parse(json) : {};
  // Every known personal field key is present in the result, defaulting to
  // null -- matches the old one-column-per-field behavior, where a NULL
  // column always decrypted to null rather than being absent from the row.
  return { ...Object.fromEntries(PERSONAL_ACCOUNT_FIELD_KEYS.map((key) => [key, null])), ...data };
}
