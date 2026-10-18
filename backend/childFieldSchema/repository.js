import { query } from '../db.js';
import { getAppSettings } from '../appSettings/repository.js';
import { decryptFieldBlob } from '../accountFields.js';

export async function getChildFieldSchema() {
  const { rows } = await query('SELECT schema FROM child_field_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setChildFieldSchema(schema) {
  const { rows } = await query('SELECT id FROM child_field_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO child_field_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE child_field_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}

// Whole years between a birthdate (yyyy-mm-dd) and today; null when the date is missing or unreadable.
export function ageInYears(birthdate, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthdate ?? ''));
  if (!m) return null;
  let age = today.getUTCFullYear() - Number(m[1]);
  if (today.getUTCMonth() + 1 < Number(m[2]) || (today.getUTCMonth() + 1 === Number(m[2]) && today.getUTCDate() < Number(m[3]))) age -= 1;
  return age;
}

// Does the person count as a child for the extra fields? Marked as a child, or younger than the age limit
// (a missing birthdate never makes someone a child). Always false with the add-on off.
export async function isChildForFields(userId, settings) {
  const { childrenEnabled, childrenAgeLimit } = settings ?? await getAppSettings();
  if (!childrenEnabled) return false;
  const { rows } = await query('SELECT is_child, account_data_enc FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) return false;
  if (rows[0].is_child) return true;
  const age = ageInYears(decryptFieldBlob(rows[0].account_data_enc).birthdate);
  return age !== null && age < childrenAgeLimit;
}

// The registration fields of this person's registration beyond the common schema: the child fields for a child.
export async function childFieldsFor(userId, settings) {
  return (await isChildForFields(userId, settings)) ? getChildFieldSchema() : [];
}
