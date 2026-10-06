import { query } from '../db.js';

export async function getGroupFieldSchema() {
  const { rows } = await query('SELECT schema FROM group_field_schema LIMIT 1');
  return rows[0]?.schema ?? [];
}

export async function setGroupFieldSchema(schema) {
  const { rows } = await query('SELECT id FROM group_field_schema LIMIT 1');
  if (rows.length === 0) {
    await query('INSERT INTO group_field_schema (schema) VALUES ($1)', [JSON.stringify(schema)]);
  } else {
    await query('UPDATE group_field_schema SET schema = $1 WHERE id = $2', [JSON.stringify(schema), rows[0].id]);
  }
  return schema;
}
