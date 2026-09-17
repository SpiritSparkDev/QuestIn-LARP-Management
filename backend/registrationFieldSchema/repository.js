import { query } from '../db.js';

export async function getRegistrationFieldSchema() {
  const { rows } = await query('SELECT schema FROM registration_field_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setRegistrationFieldSchema(schema) {
  const { rows } = await query('SELECT id FROM registration_field_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO registration_field_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE registration_field_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}
