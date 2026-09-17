import { encryptField, decryptField } from './crypto/fieldCrypto.js';

// The 6 event-scoped OT fields on registrations -- field DEFINITIONS now
// live in the admin-editable registration_field_schema (see
// backend/registrationFieldSchema). backend/groups/routes.js fetches the
// live schema instead of a static list. This fixed list is kept only for
// decryptFieldBlob's defaults below, matching the old one-column-per-field
// behavior regardless of what admins add/remove from the schema.
const DEFAULT_REGISTRATION_FIELD_KEYS = [
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
  return { ...Object.fromEntries(DEFAULT_REGISTRATION_FIELD_KEYS.map((key) => [key, null])), ...data };
}
