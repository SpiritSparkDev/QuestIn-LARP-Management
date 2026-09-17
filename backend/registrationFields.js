import { encryptField, decryptField } from './crypto/fieldCrypto.js';

// The 6 event-scoped OT fields on registrations -- field DEFINITIONS now
// live in the admin-editable registration_field_schema (see
// backend/registrationFieldSchema). This list only tracks the current set
// of keys for callers that still need a static list; migrated to the live
// schema in a later task (see backend/groups/routes.js).
export const REGISTRATION_FIELD_KEYS = [
  'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut',
];

export function encryptFieldBlob(values) {
  return encryptField(JSON.stringify(values ?? {}));
}

export function decryptFieldBlob(buffer) {
  const json = decryptField(buffer);
  const data = json ? JSON.parse(json) : {};
  // Every known field key is present in the result, defaulting to null --
  // matches the old one-column-per-field behavior, where a NULL column
  // always decrypted to null rather than being absent from the row (same
  // fix as accountFields.js's decryptFieldBlob).
  return { ...Object.fromEntries(REGISTRATION_FIELD_KEYS.map((key) => [key, null])), ...data };
}
