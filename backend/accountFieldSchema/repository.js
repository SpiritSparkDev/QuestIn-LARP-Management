import { query } from '../db.js';

export async function getAccountFieldSchema() {
  const { rows } = await query('SELECT schema FROM account_field_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setAccountFieldSchema(schema) {
  const { rows } = await query('SELECT id FROM account_field_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO account_field_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE account_field_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}
