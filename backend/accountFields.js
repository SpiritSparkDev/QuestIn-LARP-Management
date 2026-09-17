import { encryptField, decryptField } from './crypto/fieldCrypto.js';

// OT (out-of-time) account fields -- the field DEFINITIONS (key, label,
// type) now live in the admin-editable account_field_schema (see
// backend/accountFieldSchema). This list only tracks the current set of
// keys for callers that still need a static list; migrated to the live
// schema in a later task (see backend/groups/routes.js,
// backend/members/routes.js). 'group' is deliberately included here even
// though it's excluded from the schema -- it's an access-control field,
// not personal data, gated by the same permission list.
export const ACCOUNT_FIELD_KEYS = [
  'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone',
  'medicalNotes', 'group',
];

// The personal-data subset of ACCOUNT_FIELD_KEYS -- excludes 'group', which
// is an access-control field stored in its own column, not in the
// account_data_enc blob.
export const PERSONAL_ACCOUNT_FIELD_KEYS = ACCOUNT_FIELD_KEYS.filter((key) => key !== 'group');

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
